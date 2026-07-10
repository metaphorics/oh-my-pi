/**
 * Contracts for T6 lazy MCP discovery (`mcp.lazyDiscovery`):
 *
 * 1. Deferred discovery uses cached schemas, distinct pseudo-names, and longest
 *    configured server-name matching without connecting eagerly.
 * 2. Server summaries mark cached vs deferred (cache-miss) servers for prompts.
 * 3. Explicit headless selections reactivate after on-demand refresh.
 * 4. Malformed lazy config remains non-fatal and logs its parse failure.
 * 5. Search cancellation aborts on-demand waits instead of reporting unavailable.
 * 6. Stored connections are ready only after successful tool loading; failed
 *    loads are discarded and can retry.
 * 7. MCP refresh updates serialize and recover after a rejected update.
 * 8. Per-caller aborts do not cancel or poison shared connection readiness.
 * 9. Concrete transport schemas accept descriptions without opening the schema.
 * 10. Eager `discoverAndConnect` still connects at discovery time.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createMCPServerToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	formatDiscoverableToolServerSummary,
} from "@oh-my-pi/pi-coding-agent/tool-discovery/tool-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { renderSearchToolBm25Description, SearchToolBm25Tool } from "@oh-my-pi/pi-coding-agent/tools/search-tool-bm25";
import { getAgentDir, logger, removeSyncWithRetries, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";
import mcpSchema from "../src/config/mcp-schema.json" with { type: "json" };
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

const CACHED_SERVER = "cached_docs";
const DEFERRED_SERVER = "deferred_wiki";
const CACHED_TOOL_DEF: MCPToolDefinition = {
	name: "lookup_docs",
	description: "Look up product documentation by keyword",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};
const LIVE_TOOL_DEF: MCPToolDefinition = {
	name: "lookup_docs",
	description: "Live documentation lookup after connect",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};

function serverConfig(name: string, description: string): MCPServerConfig {
	return {
		type: "stdio",
		command: "echo",
		args: [name],
		description,
	};
}

function writeProjectMcpConfig(cwd: string): {
	cached: MCPServerConfig;
	deferred: MCPServerConfig;
} {
	const cached = serverConfig(CACHED_SERVER, "Cached docs server");
	const deferred = serverConfig(DEFERRED_SERVER, "Deferred wiki server");
	fs.writeFileSync(
		path.join(cwd, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				[CACHED_SERVER]: cached,
				[DEFERRED_SERVER]: deferred,
			},
		}),
	);
	return { cached, deferred };
}

function mockConnectionFor(name: string, config: MCPServerConfig): MCPServerConnection {
	const connection = createMockConnection({ tools: {} }, createMockTransport(new Map()));
	connection.name = name;
	connection.config = config;
	return connection;
}

type LazyDiscoverySession = ToolSession & {
	isMCPDiscoveryEnabled: () => boolean;
	getDiscoverableTools: (filter?: { source?: DiscoverableTool["source"] }) => DiscoverableTool[];
	getSelectedMCPToolNames: () => string[];
	activateDiscoveredMCPTools: (toolNames: string[]) => Promise<string[]>;
	refreshMCPTools?: (tools: unknown[]) => Promise<void>;
	mcpManager?: MCPManager;
};

type RefreshedMCPTool = {
	name: string;
	description?: string;
	mcpServerName?: string;
	mcpToolName?: string;
};

function isRefreshedMCPTool(tool: unknown): tool is RefreshedMCPTool {
	return typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string";
}

function createBm25Session(
	manager: MCPManager,
	options: {
		discoverableTools: DiscoverableTool[];
		activated?: string[];
	},
): LazyDiscoverySession {
	const activated = options.activated ?? [];
	let discoverableTools = options.discoverableTools;
	const initialSearchIndex = buildDiscoverableToolSearchIndex(discoverableTools);
	return {
		cwd: "/tmp/lazy-mcp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "mcp.lazyDiscovery": true, "mcp.discoveryMode": true }),
		isMCPDiscoveryEnabled: () => true,
		getDiscoverableTools: () => discoverableTools,
		getDiscoverableToolSearchIndex: () => initialSearchIndex,
		getSelectedMCPToolNames: () => [...activated],
		activateDiscoveredMCPTools: async (toolNames: string[]) => {
			for (const name of toolNames) {
				if (!activated.includes(name)) activated.push(name);
			}
			return toolNames;
		},
		refreshMCPTools: async tools => {
			// After on-demand connect, re-expose live tool names so BM25 can activate them.
			const refreshed: DiscoverableTool[] = [];
			for (const tool of tools) {
				if (!isRefreshedMCPTool(tool)) continue;
				refreshed.push({
					name: tool.name,
					label: tool.name,
					summary: tool.description ?? tool.name,
					source: "mcp" as const,
					serverName: tool.mcpServerName,
					mcpToolName: tool.mcpToolName,
					schemaKeys: [],
				});
			}
			discoverableTools = refreshed;
		},
		mcpManager: manager,
	};
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(1);
	}
}

async function getCallableMCPToolOwner(cwd: string, tools: CustomTool[], toolName: string) {
	const authStorage = await AuthStorage.create(path.join(cwd, `collision-owner-${Snowflake.next()}.db`));
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, `collision-owner-${Snowflake.next()}.yml`));
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(cwd, "agent"),
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			enableMCP: false,
			hasUI: false,
		});
		try {
			await session.refreshMCPTools(tools);
			return (session.getToolByName(toolName) as { mcpServerName?: string } | undefined)?.mcpServerName;
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
	}
}

type ClosedTransportSchema = {
	additionalProperties: false;
	properties: Record<string, unknown>;
};

function isClosedTransportSchema(value: unknown): value is ClosedTransportSchema {
	return (
		typeof value === "object" &&
		value !== null &&
		"additionalProperties" in value &&
		value.additionalProperties === false &&
		"properties" in value &&
		typeof value.properties === "object" &&
		value.properties !== null
	);
}

describe("lazy MCP discovery (T6)", () => {
	let workDir: string;
	let isolatedHome: string;
	let originalAgentDir: string;
	let storage: AgentStorage;
	let connectSpy: Mock<typeof mcpClient.connectToServer>;
	let listToolsSpy: Mock<typeof mcpClient.listTools>;
	let homedirSpy: Mock<typeof os.homedir>;

	beforeEach(async () => {
		workDir = path.join(os.tmpdir(), `omp-mcp-lazy-${Snowflake.next()}`);
		isolatedHome = path.join(os.tmpdir(), `omp-mcp-lazy-home-${Snowflake.next()}`);
		fs.mkdirSync(workDir, { recursive: true });
		fs.mkdirSync(isolatedHome, { recursive: true });
		// Capability discovery also walks user-level MCP configs under getAgentDir()
		// and os.homedir()-scoped sources (Claude/Cursor/etc). Redirect both so the
		// suite only sees the two project servers under test.
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(workDir, "agent"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(isolatedHome);
		storage = await AgentStorage.open(path.join(workDir, "agent.db"));
		connectSpy = spyOn(mcpClient, "connectToServer");
		listToolsSpy = spyOn(mcpClient, "listTools");
	});

	afterEach(async () => {
		connectSpy.mockRestore();
		listToolsSpy.mockRestore();
		homedirSpy.mockRestore();
		setAgentDir(originalAgentDir);
		mock.restore();
		AgentStorage.resetInstance();
		for (const dir of [workDir, isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	it("discoverDeferred loads cached tools without connecting", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const toolCache = new MCPToolCache(storage);
		await toolCache.set(CACHED_SERVER, cached, [CACHED_TOOL_DEF]);

		const manager = new MCPManager(workDir, toolCache);
		try {
			const result = await manager.discoverDeferred();

			expect(connectSpy).not.toHaveBeenCalled();
			expect(listToolsSpy).not.toHaveBeenCalled();
			expect(result.connectedServers).toEqual([]);
			expect(result.tools.map(tool => tool.name)).toEqual([`mcp__${CACHED_SERVER}_lookup_docs`]);
			expect(manager.getConnection(CACHED_SERVER)).toBeUndefined();
			expect(manager.getConnection(DEFERRED_SERVER)).toBeUndefined();
			expect(manager.isServerDeferred(CACHED_SERVER)).toBe(true);
			expect(manager.isServerDeferred(DEFERRED_SERVER)).toBe(true);

			const summaries = manager.getDiscoverableServerSummaries();
			expect(summaries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: CACHED_SERVER,
						toolCount: 1,
						cached: true,
						deferred: false,
						description: "Cached docs server",
					}),
					expect.objectContaining({
						name: DEFERRED_SERVER,
						toolCount: 0,
						cached: false,
						deferred: true,
						description: "Deferred wiki server",
					}),
				]),
			);

			const deferredPseudo = manager.getDeferredDiscoverableTools();
			const deferredNames = deferredPseudo.map(tool => tool.name);
			expect(deferredNames).toContain(createMCPServerToolName(DEFERRED_SERVER));
			expect(deferredNames).not.toContain(`mcp__${CACHED_SERVER}_lookup_docs`);
			const deferredEntry = deferredPseudo.find(tool => tool.serverName === DEFERRED_SERVER);
			expect(deferredEntry?.deferredServer).toBe(true);
			expect(deferredEntry?.summary).toBe("Deferred wiki server");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("ignores description-only edits in cache identity but invalidates transport edits", async () => {
		const toolCache = new MCPToolCache(storage);
		const storedConfig: MCPServerConfig = {
			type: "stdio",
			command: "cached-server",
			args: ["--mode", "docs"],
			env: { TENANT: "alpha" },
			auth: { type: "apikey", credentialId: "credential-a" },
			description: "Original display description",
		};
		await toolCache.set(CACHED_SERVER, storedConfig, [CACHED_TOOL_DEF]);

		expect(
			await toolCache.get(CACHED_SERVER, {
				...storedConfig,
				description: "Updated display description",
			}),
		).toEqual([CACHED_TOOL_DEF]);
		expect(
			await toolCache.get(CACHED_SERVER, {
				...storedConfig,
				env: { TENANT: "beta" },
			}),
		).toBeNull();
		expect(
			await toolCache.get(CACHED_SERVER, {
				...storedConfig,
				auth: { type: "apikey", credentialId: "credential-b" },
			}),
		).toBeNull();
		expect(
			await toolCache.get(CACHED_SERVER, {
				...storedConfig,
				command: "replacement-server",
			}),
		).toBeNull();
	});

	it("validates guarded cache ownership after hashing and at the persistent write boundary", async () => {
		const config = serverConfig(CACHED_SERVER, "Cached docs server");
		const toolCache = new MCPToolCache(storage);
		const shouldCommit = mock(() => true);

		await toolCache.set(CACHED_SERVER, config, [CACHED_TOOL_DEF], shouldCommit);

		expect(shouldCommit).toHaveBeenCalledTimes(2);
		expect(await toolCache.get(CACHED_SERVER, config)).toEqual([CACHED_TOOL_DEF]);
	});

	it("resolves lazy MCP tool names against the longest configured sanitized server name", async () => {
		fs.writeFileSync(
			path.join(workDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					github: serverConfig("github", "GitHub"),
					"github-mcp": serverConfig("github-mcp", "GitHub MCP"),
				},
			}),
		);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		try {
			await manager.discoverDeferred();

			expect(manager.resolveServerNameFromToolName("mcp__github_mcp_search")).toBe("github-mcp");
			expect(manager.resolveServerNameFromToolName("mcp__github_search")).toBe("github");
			expect(manager.resolveServerNameFromToolName("mcp__missing_search")).toBeUndefined();
		} finally {
			await manager.disconnectAll();
		}
	});

	it("deferred server pseudo-entry does not overwrite a real MCP tool name", () => {
		const realTool: DiscoverableTool = {
			name: "mcp__foo_bar",
			label: "foo/bar",
			summary: "Real foo tool",
			source: "mcp",
			serverName: "foo",
			mcpToolName: "bar",
			schemaKeys: [],
		};
		const deferredServer: DiscoverableTool = {
			name: createMCPServerToolName("foo_bar"),
			label: "foo_bar",
			summary: "Deferred foo_bar server",
			source: "mcp",
			serverName: "foo_bar",
			deferredServer: true,
			schemaKeys: [],
		};
		const discoverableByName = new Map([realTool, deferredServer].map(tool => [tool.name, tool]));

		expect([...discoverableByName.keys()]).toEqual(expect.arrayContaining(["mcp__foo_bar", "mcp__server__foo_bar"]));
		expect(discoverableByName.get("mcp__foo_bar")?.deferredServer).not.toBe(true);
	});

	it("prompt summaries advertise cached and deferred servers", () => {
		const rendered = renderSearchToolBm25Description(
			[
				{
					name: `mcp__${CACHED_SERVER}_lookup_docs`,
					label: `${CACHED_SERVER}/lookup_docs`,
					summary: CACHED_TOOL_DEF.description ?? "docs",
					source: "mcp",
					serverName: CACHED_SERVER,
					mcpToolName: "lookup_docs",
					schemaKeys: ["query"],
				},
				{
					name: createMCPServerToolName(DEFERRED_SERVER),
					label: DEFERRED_SERVER,
					summary: `MCP server "${DEFERRED_SERVER}" — tools not yet loaded; searching or calling loads them`,
					source: "mcp",
					serverName: DEFERRED_SERVER,
					deferredServer: true,
					schemaKeys: [],
				},
			],
			[
				{
					name: CACHED_SERVER,
					toolCount: 1,
					cached: true,
					deferred: false,
					description: "Cached docs server",
				},
				{
					name: DEFERRED_SERVER,
					toolCount: 0,
					cached: false,
					deferred: true,
					description: "Deferred wiki server",
				},
			],
		);

		expect(rendered).toContain(
			formatDiscoverableToolServerSummary({
				name: CACHED_SERVER,
				toolCount: 1,
				cached: true,
				description: "Cached docs server",
			}),
		);
		expect(rendered).toContain(
			formatDiscoverableToolServerSummary({
				name: DEFERRED_SERVER,
				toolCount: 0,
				deferred: true,
				description: "Deferred wiki server",
			}),
		);
		expect(rendered).toContain(`${CACHED_SERVER} (1 tool cached)`);
		expect(rendered).toContain(`${DEFERRED_SERVER} (deferred)`);
	});

	it("reactivates explicitly requested lazy MCP tools after on-demand refresh", async () => {
		writeProjectMcpConfig(workDir);
		const toolName = `mcp__${CACHED_SERVER}_lookup_docs`;
		// Intentionally uncached: FIX B must activate after live connect/list/refresh,
		// not via a pre-seeded MCPToolCache schema that already looks selected.
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		await manager.discoverDeferred();
		connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => mockConnectionFor(name, config));
		listToolsSpy.mockImplementation(() => toolLoad.promise);
		const authStorage = await AuthStorage.create(path.join(workDir, `lazy-reactivation-${Snowflake.next()}.db`));
		const modelRegistry = new ModelRegistry(authStorage, path.join(workDir, "lazy-reactivation-models.yml"));
		try {
			const { session } = await createAgentSession({
				cwd: workDir,
				agentDir: path.join(workDir, "agent"),
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "mcp.lazyDiscovery": true, "mcp.discoveryMode": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				hasUI: false,
				mcpManager: manager,
				toolNames: [toolName],
			});
			try {
				// Explicit requested name starts absent until connect/list/refresh/activation.
				expect(session.getSelectedMCPToolNames()).not.toContain(toolName);
				expect(session.getActiveToolNames()).not.toContain(toolName);

				toolLoad.resolve([LIVE_TOOL_DEF]);
				await waitFor(
					() => session.getActiveToolNames().includes(toolName),
					"Timed out waiting for requested lazy MCP tool activation",
				);
				expect(session.getSelectedMCPToolNames()).toContain(toolName);
				expect(session.getActiveToolNames()).toContain(toolName);
			} finally {
				toolLoad.resolve([LIVE_TOOL_DEF]);
				await session.dispose();
			}
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			authStorage.close();
			await manager.disconnectAll();
		}
	});

	it("waits for a stored connection's tool load before activating a requested tool", async () => {
		writeProjectMcpConfig(workDir);
		const toolName = `mcp__${CACHED_SERVER}_lookup_docs`;
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		const authStorage = await AuthStorage.create(path.join(workDir, `stored-loading-${Snowflake.next()}.db`));
		const modelRegistry = new ModelRegistry(authStorage, path.join(workDir, "stored-loading-models.yml"));
		let session: AgentSession | undefined;
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => toolLoad.promise);
			const startupConnect = manager.connectServerOnDemand(CACHED_SERVER);
			await waitFor(
				() => manager.getConnection(CACHED_SERVER) !== undefined,
				"Timed out waiting for stored MCP connection",
			);

			({ session } = await createAgentSession({
				cwd: workDir,
				agentDir: path.join(workDir, "agent"),
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "mcp.lazyDiscovery": true, "mcp.discoveryMode": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				hasUI: false,
				mcpManager: manager,
				toolNames: [toolName],
			}));
			expect(session.getSelectedMCPToolNames()).not.toContain(toolName);
			expect(session.getActiveToolNames()).not.toContain(toolName);

			toolLoad.resolve([LIVE_TOOL_DEF]);
			await startupConnect;
			await waitFor(
				() => session?.getActiveToolNames().includes(toolName) === true,
				"Timed out waiting for stored MCP tool activation after readiness",
			);
			expect(session.getSelectedMCPToolNames()).toContain(toolName);
			expect(session.getActiveToolNames()).toContain(toolName);
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			await session?.dispose();
			authStorage.close();
			await manager.disconnectAll();
		}
	});

	it("serializes owned-manager tool refresh before requested-tool activation", async () => {
		writeProjectMcpConfig(workDir);
		const toolName = `mcp__${CACHED_SERVER}_lookup_docs`;
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => mockConnectionFor(name, config));
		listToolsSpy.mockImplementation(() => toolLoad.promise);
		const authStorage = await AuthStorage.create(path.join(workDir, `serialized-refresh-${Snowflake.next()}.db`));
		const modelRegistry = new ModelRegistry(authStorage, path.join(workDir, "serialized-refresh-models.yml"));
		const firstRefreshStarted = Promise.withResolvers<void>();
		const releaseFirstRefresh = Promise.withResolvers<void>();
		let session: AgentSession | undefined;
		let manager: MCPManager | undefined;
		try {
			({ session, mcpManager: manager } = await createAgentSession({
				cwd: workDir,
				agentDir: path.join(workDir, "agent"),
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "mcp.lazyDiscovery": true, "mcp.discoveryMode": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				hasUI: false,
				toolNames: [toolName],
			}));
			const originalRefresh = session.refreshMCPTools.bind(session);
			const activeSession = session;
			let refreshCalls = 0;
			spyOn(session, "refreshMCPTools").mockImplementation(async (tools, options) => {
				refreshCalls++;
				if (refreshCalls === 1) {
					firstRefreshStarted.resolve();
					await releaseFirstRefresh.promise;
				}
				await originalRefresh(tools, options);
				if (refreshCalls === 1) activeSession.agent.setSystemPrompt(["stale-pre-activation-prompt"]);
			});

			toolLoad.resolve([LIVE_TOOL_DEF]);
			await firstRefreshStarted.promise;
			await Bun.sleep(0);
			expect(refreshCalls).toBe(1);
			expect(session.getActiveToolNames()).not.toContain(toolName);

			releaseFirstRefresh.resolve();
			await waitFor(
				() =>
					session?.getActiveToolNames().includes(toolName) === true &&
					session.systemPrompt[0] !== "stale-pre-activation-prompt",
				"Timed out waiting for serialized MCP activation and prompt application",
			);
			expect(refreshCalls).toBe(2);
			expect(session.getSelectedMCPToolNames()).toContain(toolName);
			expect(session.systemPrompt).not.toEqual(["stale-pre-activation-prompt"]);
		} finally {
			releaseFirstRefresh.resolve();
			await session?.dispose();
			authStorage.close();
			await manager?.disconnectAll();
		}
	});

	it("recovers the MCP update queue after a refresh rejects", async () => {
		writeProjectMcpConfig(workDir);
		const toolName = `mcp__${CACHED_SERVER}_lookup_docs`;
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => mockConnectionFor(name, config));
		listToolsSpy.mockImplementation(() => toolLoad.promise);
		const authStorage = await AuthStorage.create(path.join(workDir, `queue-recovery-${Snowflake.next()}.db`));
		const modelRegistry = new ModelRegistry(authStorage, path.join(workDir, "queue-recovery-models.yml"));
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		let session: AgentSession | undefined;
		let manager: MCPManager | undefined;
		try {
			({ session, mcpManager: manager } = await createAgentSession({
				cwd: workDir,
				agentDir: path.join(workDir, "agent"),
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "mcp.lazyDiscovery": true, "mcp.discoveryMode": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				hasUI: false,
				toolNames: [toolName],
			}));
			const originalRefresh = session.refreshMCPTools.bind(session);
			let refreshCalls = 0;
			spyOn(session, "refreshMCPTools").mockImplementation(async (tools, options) => {
				refreshCalls++;
				if (refreshCalls === 1) throw new Error("first queued refresh rejected");
				await originalRefresh(tools, options);
			});

			toolLoad.resolve([LIVE_TOOL_DEF]);
			await waitFor(
				() => session?.getActiveToolNames().includes(toolName) === true,
				"Timed out waiting for MCP update queue recovery",
			);

			expect(refreshCalls).toBe(2);
			expect(warnSpy).toHaveBeenCalledWith("MCP tool refresh failed", {
				error: "first queued refresh rejected",
			});
			expect(session.getSelectedMCPToolNames()).toContain(toolName);
			expect(session.getActiveToolNames()).toContain(toolName);
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			warnSpy.mockRestore();
			await session?.dispose();
			authStorage.close();
			await manager?.disconnectAll();
		}
	});

	it("does not activate requested MCP tools when disposal starts during refresh", async () => {
		writeProjectMcpConfig(workDir);
		const toolName = `mcp__${CACHED_SERVER}_lookup_docs`;
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		const authStorage = await AuthStorage.create(path.join(workDir, `dispose-refresh-${Snowflake.next()}.db`));
		const modelRegistry = new ModelRegistry(authStorage, path.join(workDir, "dispose-refresh-models.yml"));
		let session: AgentSession | undefined;
		let refreshCompleted = false;
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => toolLoad.promise);
			const startupConnect = manager.connectServerOnDemand(CACHED_SERVER);
			await waitFor(
				() => manager.getConnection(CACHED_SERVER) !== undefined,
				"Timed out waiting for stored MCP connection",
			);
			({ session } = await createAgentSession({
				cwd: workDir,
				agentDir: path.join(workDir, "agent"),
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "mcp.lazyDiscovery": true, "mcp.discoveryMode": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				hasUI: false,
				mcpManager: manager,
				toolNames: [toolName],
			}));
			const originalRefresh = session.refreshMCPTools.bind(session);
			spyOn(session, "refreshMCPTools").mockImplementation(async (tools, options) => {
				await originalRefresh(tools, options);
				await session?.dispose();
				refreshCompleted = true;
			});
			const activateSpy = spyOn(session, "activateDiscoveredMCPTools");

			toolLoad.resolve([LIVE_TOOL_DEF]);
			await startupConnect;
			await waitFor(() => refreshCompleted, "Timed out waiting for MCP refresh disposal");
			await Bun.sleep(0);
			expect(session.isDisposed).toBe(true);
			expect(activateSpy).not.toHaveBeenCalled();
			expect(session.getSelectedMCPToolNames()).not.toContain(toolName);
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			await session?.dispose();
			authStorage.close();
			await manager.disconnectAll();
		}
	});

	for (const hasUI of [false, true]) {
		it(`malformed lazy MCP config is non-fatal with hasUI=${hasUI}`, async () => {
			fs.mkdirSync(getAgentDir(), { recursive: true });
			fs.writeFileSync(path.join(getAgentDir(), "mcp.json"), '{"mcpServers":');
			const authStorage = await AuthStorage.create(path.join(workDir, `malformed-${hasUI}-${Snowflake.next()}.db`));
			const modelRegistry = new ModelRegistry(authStorage, path.join(workDir, `malformed-${hasUI}-models.yml`));
			const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
			try {
				const { session } = await createAgentSession({
					cwd: workDir,
					agentDir: path.join(workDir, "agent"),
					authStorage,
					modelRegistry,
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({ "mcp.lazyDiscovery": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableLsp: false,
					hasUI,
				});
				try {
					expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
					expect(errorSpy).toHaveBeenCalledWith("MCP tool load failed", {
						path: ".mcp.json",
						error: expect.stringContaining("JSON Parse error: Unexpected EOF"),
					});
				} finally {
					await session.dispose();
				}
			} finally {
				errorSpy.mockRestore();
				authStorage.close();
			}
		});
	}

	it("search_tool_bm25 matching a cached lazy tool connects once and activates it", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const toolCache = new MCPToolCache(storage);
		await toolCache.set(CACHED_SERVER, cached, [CACHED_TOOL_DEF]);

		const manager = new MCPManager(workDir, toolCache);
		try {
			await manager.discoverDeferred();
			expect(connectSpy).not.toHaveBeenCalled();

			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => {
				expect(name).toBe(CACHED_SERVER);
				return mockConnectionFor(name, config);
			});
			// #connectAndWireServer always listTools after connect.
			listToolsSpy.mockResolvedValue([LIVE_TOOL_DEF]);

			const discoverableTools: DiscoverableTool[] = [
				{
					name: `mcp__${CACHED_SERVER}_lookup_docs`,
					label: `${CACHED_SERVER}/lookup_docs`,
					summary: CACHED_TOOL_DEF.description ?? "docs",
					source: "mcp",
					serverName: CACHED_SERVER,
					mcpToolName: "lookup_docs",
					schemaKeys: ["query"],
				},
			];
			const session = createBm25Session(manager, { discoverableTools });
			const tool = new SearchToolBm25Tool(session);

			const result = await tool.execute("call-lazy-activate", { query: "documentation lookup", limit: 1 });

			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(connectSpy.mock.calls[0]?.[0]).toBe(CACHED_SERVER);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);
			expect(manager.getConnection(CACHED_SERVER)).toBeDefined();
			expect(manager.isServerDeferred(CACHED_SERVER)).toBe(false);
			expect(result.details?.activated_tools).toEqual([`mcp__${CACHED_SERVER}_lookup_docs`]);
			expect(result.details?.unavailable_servers).toBeUndefined();
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining(`mcp__${CACHED_SERVER}_lookup_docs`),
			});

			// A second search for the same already-selected match must not reconnect.
			const second = await tool.execute("call-lazy-again", { query: "documentation lookup", limit: 1 });
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(second.details?.activated_tools).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("search_tool_bm25 aborts while waiting for lazy MCP on-demand connect", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const toolCache = new MCPToolCache(storage);
		await toolCache.set(CACHED_SERVER, cached, [CACHED_TOOL_DEF]);
		const manager = new MCPManager(workDir, toolCache);
		const connectionReady = Promise.withResolvers<void>();
		try {
			await manager.discoverDeferred();
			const connectStarted = Promise.withResolvers<void>();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => {
				connectStarted.resolve();
				await connectionReady.promise;
				return mockConnectionFor(name, config);
			});
			listToolsSpy.mockResolvedValue([LIVE_TOOL_DEF]);
			const originalConnectServerOnDemand = manager.connectServerOnDemand.bind(manager);
			let observedSignal: AbortSignal | undefined;
			spyOn(manager, "connectServerOnDemand").mockImplementation((name, signal) => {
				observedSignal = signal;
				return originalConnectServerOnDemand(name, signal);
			});
			const discoverableTools: DiscoverableTool[] = [
				{
					name: `mcp__${CACHED_SERVER}_lookup_docs`,
					label: `${CACHED_SERVER}/lookup_docs`,
					summary: CACHED_TOOL_DEF.description ?? "docs",
					source: "mcp",
					serverName: CACHED_SERVER,
					mcpToolName: "lookup_docs",
					schemaKeys: ["query"],
				},
			];
			const tool = new SearchToolBm25Tool(createBm25Session(manager, { discoverableTools }));
			const controller = new AbortController();
			const execution = tool.execute("call-abort", { query: "documentation lookup", limit: 1 }, controller.signal);
			await connectStarted.promise;
			controller.abort(new DOMException("cancelled", "AbortError"));

			const promptRejection = Promise.race([
				execution,
				Bun.sleep(250).then(() => {
					throw new Error("Timed out waiting for lazy MCP search cancellation");
				}),
			]);
			await expect(promptRejection).rejects.toMatchObject({ name: "AbortError" });
			expect(observedSignal).toBe(controller.signal);
		} finally {
			connectionReady.resolve();
			await manager.connectServerOnDemand(CACHED_SERVER).catch(() => undefined);
			await manager.disconnectAll();
		}
	});

	it("isolates one caller's abort from a shared on-demand attempt", async () => {
		writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const listStarted = Promise.withResolvers<void>();
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => {
				listStarted.resolve();
				return toolLoad.promise;
			});
			const controller = new AbortController();
			const first = manager.connectServerOnDemand(CACHED_SERVER, controller.signal);
			await listStarted.promise;
			let secondSettled = false;
			const secondResult = manager.connectServerOnDemand(CACHED_SERVER).then(
				() => {
					secondSettled = true;
					return undefined;
				},
				error => {
					secondSettled = true;
					return error;
				},
			);

			controller.abort(new DOMException("cancel first waiter", "AbortError"));
			await expect(first).rejects.toMatchObject({ name: "AbortError", message: "cancel first waiter" });
			await Promise.resolve();
			expect(secondSettled).toBe(false);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);

			toolLoad.resolve([LIVE_TOOL_DEF]);
			expect(await secondResult).toBeUndefined();
			expect(secondSettled).toBe(true);
			expect(manager.getTools().map(tool => tool.name)).toContain(`mcp__${CACHED_SERVER}_lookup_docs`);
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			await manager.disconnectAll();
		}
	});

	it("search_tool_bm25 waits for stored connection tool load before refresh", async () => {
		writeProjectMcpConfig(workDir);
		const toolName = `mcp__${CACHED_SERVER}_lookup_docs`;
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		const originalConnectServerOnDemand = manager.connectServerOnDemand.bind(manager);
		let readinessSpy: { mockRestore: () => void } | undefined;
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => toolLoad.promise);

			// Store the connection before listTools finishes so a getConnection()
			// presence check would incorrectly skip readiness-aware connect.
			const startupConnect = manager.connectServerOnDemand(CACHED_SERVER);
			await waitFor(
				() => manager.getConnection(CACHED_SERVER) !== undefined,
				"Timed out waiting for stored MCP connection",
			);

			let readinessEntered = false;
			readinessSpy = spyOn(manager, "connectServerOnDemand").mockImplementation((name, signal) => {
				if (name === CACHED_SERVER) readinessEntered = true;
				return originalConnectServerOnDemand(name, signal);
			});

			const discoverableTools: DiscoverableTool[] = [
				{
					name: toolName,
					label: `${CACHED_SERVER}/lookup_docs`,
					summary: CACHED_TOOL_DEF.description ?? "docs",
					source: "mcp",
					serverName: CACHED_SERVER,
					mcpToolName: "lookup_docs",
					schemaKeys: ["query"],
				},
			];
			const session = createBm25Session(manager, { discoverableTools });
			const tool = new SearchToolBm25Tool(session);
			let searchSettled = false;
			const search = tool
				.execute("call-stored-loading", { query: "documentation lookup", limit: 1 })
				.then(result => {
					searchSettled = true;
					return result;
				});

			// If getConnection() early-return is restored, search never joins readiness.
			await waitFor(() => readinessEntered, "Timed out waiting for search to enter connectServerOnDemand readiness");
			expect(searchSettled).toBe(false);
			expect(session.getSelectedMCPToolNames()).not.toContain(toolName);

			toolLoad.resolve([LIVE_TOOL_DEF]);
			await startupConnect;
			const result = await search;
			expect(searchSettled).toBe(true);
			expect(result.details?.activated_tools).toEqual([toolName]);
			expect(session.getSelectedMCPToolNames()).toContain(toolName);
			expect(manager.getTools().map(entry => entry.name)).toContain(toolName);
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			readinessSpy?.mockRestore();
			await manager.disconnectAll();
		}
	});

	it("search_tool_bm25 reports unavailable when on-demand connect fails", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const toolCache = new MCPToolCache(storage);
		await toolCache.set(CACHED_SERVER, cached, [CACHED_TOOL_DEF]);

		const manager = new MCPManager(workDir, toolCache);
		try {
			await manager.discoverDeferred();
			connectSpy.mockRejectedValue(new Error("spawn EACCES"));

			const discoverableTools: DiscoverableTool[] = [
				{
					name: `mcp__${CACHED_SERVER}_lookup_docs`,
					label: `${CACHED_SERVER}/lookup_docs`,
					summary: CACHED_TOOL_DEF.description ?? "docs",
					source: "mcp",
					serverName: CACHED_SERVER,
					mcpToolName: "lookup_docs",
					schemaKeys: ["query"],
				},
			];
			const session = createBm25Session(manager, { discoverableTools });
			const tool = new SearchToolBm25Tool(session);

			const result = await tool.execute("call-lazy-fail", { query: "documentation lookup", limit: 1 });

			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(manager.getConnection(CACHED_SERVER)).toBeUndefined();
			const unavailable = `server "${CACHED_SERVER}" unavailable: spawn EACCES`;
			expect(result.details?.unavailable_servers).toEqual([unavailable]);
			// Content is a JSON payload; quotes are escaped, so parse then assert.
			const contentText = result.content
				.filter(
					(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
				)
				.map(part => part.text)
				.join("\n");
			const payload = JSON.parse(contentText) as { unavailable_servers?: string[] };
			expect(payload.unavailable_servers).toEqual([unavailable]);
			expect(result.details?.activated_tools).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("connectServerOnDemand waits for tool loading after connection is stored", async () => {
		writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => toolLoad.promise);

			const first = manager.connectServerOnDemand(CACHED_SERVER);
			await waitFor(
				() => manager.getConnection(CACHED_SERVER) !== undefined,
				"Timed out waiting for MCP connection storage",
			);
			let secondResolved = false;
			const second = manager.connectServerOnDemand(CACHED_SERVER).then(() => {
				secondResolved = true;
			});
			await Promise.resolve();

			expect(secondResolved).toBe(false);
			expect(manager.getTools().map(tool => tool.name)).not.toContain(`mcp__${CACHED_SERVER}_lookup_docs`);

			toolLoad.resolve([LIVE_TOOL_DEF]);
			await Promise.all([first, second]);
			expect(manager.getTools().map(tool => tool.name)).toContain(`mcp__${CACHED_SERVER}_lookup_docs`);
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			await manager.disconnectAll();
		}
	});

	it("retries after a stored connection's tool load rejects", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const firstConnection = mockConnectionFor(CACHED_SERVER, cached);
		const closeStarted = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		const toolLoadError = new Error("tools/list rejected");
		let firstConnectionCloseCalls = 0;
		firstConnection.transport.close = async () => {
			firstConnectionCloseCalls++;
			closeStarted.resolve();
			await releaseClose.promise;
		};
		connectSpy
			.mockResolvedValueOnce(firstConnection)
			.mockImplementation(async (name: string, config: MCPServerConfig) => mockConnectionFor(name, config));
		listToolsSpy.mockRejectedValueOnce(toolLoadError).mockResolvedValueOnce([LIVE_TOOL_DEF]);
		try {
			const initialLoad = manager.connectServers({ [CACHED_SERVER]: cached }, {});
			await closeStarted.promise;
			expect(manager.getConnection(CACHED_SERVER)).toBe(firstConnection);

			let readinessSettled = false;
			const readinessResult = manager.connectServerOnDemand(CACHED_SERVER).then(
				() => {
					readinessSettled = true;
					return undefined;
				},
				error => {
					readinessSettled = true;
					return error;
				},
			);
			await Promise.resolve();
			expect(readinessSettled).toBe(false);

			releaseClose.resolve();
			const initial = await initialLoad;
			expect(initial.errors.get(CACHED_SERVER)).toBe("tools/list rejected");
			expect(await readinessResult).toBe(toolLoadError);
			expect(manager.getConnection(CACHED_SERVER)).toBeUndefined();

			await manager.connectServerOnDemand(CACHED_SERVER);

			expect(firstConnectionCloseCalls).toBe(1);
			expect(connectSpy).toHaveBeenCalledTimes(2);
			expect(listToolsSpy).toHaveBeenCalledTimes(2);
			expect(manager.getConnection(CACHED_SERVER)).not.toBe(firstConnection);
			expect(manager.getTools().map(tool => tool.name)).toContain(`mcp__${CACHED_SERVER}_lookup_docs`);
		} finally {
			releaseClose.resolve();
			await manager.disconnectAll();
		}
	});

	it("connectServerOnDemand reuses an existing pending connection", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const connectionReady = Promise.withResolvers<MCPServerConnection>();
		try {
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => {
				expect(name).toBe(CACHED_SERVER);
				return connectionReady.promise.then(() => mockConnectionFor(name, config));
			});
			listToolsSpy.mockResolvedValue([LIVE_TOOL_DEF]);

			const startupConnect = manager.connectServers({ [CACHED_SERVER]: cached }, {}, undefined);
			await Promise.resolve();
			expect(connectSpy).toHaveBeenCalledTimes(1);

			const onDemandConnect = manager.connectServerOnDemand(CACHED_SERVER);
			await Promise.resolve();
			expect(connectSpy).toHaveBeenCalledTimes(1);

			connectionReady.resolve(mockConnectionFor(CACHED_SERVER, cached));
			await onDemandConnect;
			await startupConnect;

			expect(listToolsSpy).toHaveBeenCalledTimes(1);
			expect(manager.getConnection(CACHED_SERVER)).toBeDefined();
			expect(manager.getTools().map(tool => tool.name)).toContain(`mcp__${CACHED_SERVER}_lookup_docs`);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("search and on-demand waiters join one reconnect with isolated aborts and tool readiness", async () => {
		writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const connectionReady = Promise.withResolvers<void>();
		const listToolsStarted = Promise.withResolvers<void>();
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => {
				await connectionReady.promise;
				return mockConnectionFor(name, config);
			});
			listToolsSpy.mockImplementation(() => {
				listToolsStarted.resolve();
				return toolLoad.promise;
			});

			const reconnect = manager.reconnectServer(DEFERRED_SERVER);
			await Promise.resolve();
			expect(connectSpy).toHaveBeenCalledTimes(1);

			const controller = new AbortController();
			const aborted = manager.connectServerOnDemand(DEFERRED_SERVER, controller.signal).then(
				() => undefined,
				error => error,
			);
			const session = createBm25Session(manager, {
				discoverableTools: manager
					.getDeferredDiscoverableTools()
					.filter(tool => tool.serverName === DEFERRED_SERVER),
			});
			const search = new SearchToolBm25Tool(session).execute("join-reconnect", {
				query: "Deferred wiki server",
				limit: 5,
			});
			await Promise.resolve();
			expect(connectSpy).toHaveBeenCalledTimes(1);

			controller.abort();
			expect(await aborted).toMatchObject({ name: "AbortError" });
			connectionReady.resolve();
			await listToolsStarted.promise;
			expect(listToolsSpy).toHaveBeenCalledTimes(1);
			let searchSettled = false;
			void search.finally(() => {
				searchSettled = true;
			});
			await Promise.resolve();
			expect(searchSettled).toBe(false);

			toolLoad.resolve([LIVE_TOOL_DEF]);
			const [reconnected, result] = await Promise.all([reconnect, search]);
			expect(reconnected).toBeDefined();
			expect(result.details?.activated_tools).toContain(`mcp__${DEFERRED_SERVER}_lookup_docs`);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);
		} finally {
			connectionReady.resolve();
			toolLoad.resolve([LIVE_TOOL_DEF]);
			await manager.disconnectAll();
		}
	});

	it("a joined reconnect failure is observable and a later on-demand retry connects once", async () => {
		writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const rejectReconnect = Promise.withResolvers<void>();
		const retryConnectionReady = Promise.withResolvers<void>();
		const reconnectError = new Error("reconnect transport failed");
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementationOnce(async () => {
				await rejectReconnect.promise;
				throw reconnectError;
			});
			listToolsSpy.mockResolvedValue([LIVE_TOOL_DEF]);

			const reconnect = manager.reconnectServer(DEFERRED_SERVER);
			await Promise.resolve();
			const joined = manager.connectServerOnDemand(DEFERRED_SERVER).then(
				() => undefined,
				error => error,
			);
			// Invalidate the configuration epoch while the transport attempt is latched.
			// Its rejection then terminates the shared reconnect without wall-clock backoff.
			await manager.disconnectAll();
			rejectReconnect.resolve();

			expect(await reconnect).toBeNull();
			expect(await joined).toMatchObject({ message: `MCP server failed to reconnect: ${DEFERRED_SERVER}` });
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(manager.getConnection(DEFERRED_SERVER)).toBeUndefined();

			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => {
				await retryConnectionReady.promise;
				return mockConnectionFor(name, config);
			});
			const firstRetry = manager.connectServerOnDemand(DEFERRED_SERVER);
			const secondRetry = manager.connectServerOnDemand(DEFERRED_SERVER);
			await Promise.resolve();
			expect(connectSpy).toHaveBeenCalledTimes(2);
			retryConnectionReady.resolve();
			await Promise.all([firstRetry, secondRetry]);
			expect(connectSpy).toHaveBeenCalledTimes(2);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);
			expect(manager.getTools().map(tool => tool.name)).toContain(`mcp__${DEFERRED_SERVER}_lookup_docs`);
		} finally {
			rejectReconnect.resolve();
			retryConnectionReady.resolve();
			await manager.disconnectAll();
		}
	});

	it("MCP schema allows description on every concrete transport", () => {
		for (const serverName of ["stdioServer", "httpServer", "sseServer"] as const) {
			const transportSchema = mcpSchema.$defs[serverName].allOf.find(isClosedTransportSchema);
			expect(transportSchema).toBeDefined();
			if (!transportSchema?.properties) {
				throw new Error(`Expected ${serverName} closed transport schema to define properties`);
			}
			expect(transportSchema.additionalProperties).toBe(false);
			expect(transportSchema.properties.description).toEqual({
				type: "string",
				description: "Human-readable server description shown in lazy discovery summaries.",
			});
		}
	});

	it("waitForConnection starts on-demand connect for deferred cached tools", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const toolCache = new MCPToolCache(storage);
		await toolCache.set(CACHED_SERVER, cached, [CACHED_TOOL_DEF]);

		const manager = new MCPManager(workDir, toolCache);
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockResolvedValue([LIVE_TOOL_DEF]);

			const connection = await manager.waitForConnection(CACHED_SERVER);

			expect(connection.name).toBe(CACHED_SERVER);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);
			expect(manager.getTools().map(tool => tool.name)).toContain(`mcp__${CACHED_SERVER}_lookup_docs`);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("eager discoverAndConnect still connects at discovery time", async () => {
		const { cached } = writeProjectMcpConfig(workDir);
		const toolCache = new MCPToolCache(storage);
		await toolCache.set(CACHED_SERVER, cached, [CACHED_TOOL_DEF]);

		const manager = new MCPManager(workDir, toolCache);
		try {
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(async (connection: MCPServerConnection) => {
				if (connection.name === CACHED_SERVER) return [LIVE_TOOL_DEF];
				return [
					{
						name: "search_wiki",
						description: "Search the deferred wiki",
						inputSchema: { type: "object", properties: {} },
					},
				];
			});

			const result = await manager.discoverAndConnect();

			expect(connectSpy).toHaveBeenCalled();
			const connectedNames = new Set(connectSpy.mock.calls.map((call: unknown[]) => String(call[0])));
			expect(connectedNames.has(CACHED_SERVER)).toBe(true);
			expect(connectedNames.has(DEFERRED_SERVER)).toBe(true);
			expect(result.connectedServers).toEqual(expect.arrayContaining([CACHED_SERVER, DEFERRED_SERVER]));
			expect(manager.getConnection(CACHED_SERVER)).toBeDefined();
			expect(manager.getConnection(DEFERRED_SERVER)).toBeDefined();
			expect(manager.isServerDeferred(CACHED_SERVER)).toBe(false);
			expect(manager.isServerDeferred(DEFERRED_SERVER)).toBe(false);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("resolves lazy tool names by owning-server metadata and non-stealing prefix fallback", async () => {
		// Ambiguous namespace: server `foo` (tools `bar`, `bar_baz`) and server
		// `foo_bar` (tool `baz`) all normalize under `mcp__foo_...`. Pseudo-entries
		// use `mcp__server__<server>`, so a bare `mcp__foo_bar` is a real
		// `<server>_<tool>` (server `foo`, tool `bar`), NOT a name-equality match
		// for configured server `foo_bar`.
		fs.writeFileSync(
			path.join(workDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					foo: serverConfig("foo", "Foo server"),
					foo_bar: serverConfig("foo_bar", "Foo bar server"),
				},
			}),
		);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockResolvedValue([
				{ name: "bar", description: "Foo bar tool", inputSchema: { type: "object", properties: {} } },
				{ name: "bar_baz", description: "Foo bar_baz tool", inputSchema: { type: "object", properties: {} } },
			]);

			// Uncached fallback: configured `foo_bar` must NOT steal a bare
			// `mcp__foo_bar` via name-equality; only a real `<server>_<tool>` prefix
			// qualifies, so it resolves to server `foo` (tool `bar`).
			expect(manager.resolveServerNameFromToolName("mcp__foo_bar")).toBe("foo");
			// Longest configured sanitized prefix still wins where no live tool exists.
			expect(manager.resolveServerNameFromToolName("mcp__foo_bar_baz")).toBe("foo_bar");

			// Load `foo`'s live tools (`bar` → mcp__foo_bar, `bar_baz` →
			// mcp__foo_bar_baz, both mcpServerName `foo`).
			await manager.connectServerOnDemand("foo");
			expect(manager.getTools().map(tool => tool.name)).toEqual(
				expect.arrayContaining(["mcp__foo_bar", "mcp__foo_bar_baz"]),
			);

			// Exact live-metadata now wins: `mcp__foo_bar_baz` resolves to its true
			// owner `foo`, overriding the longer prefix-colliding config `foo_bar`.
			expect(manager.resolveServerNameFromToolName("mcp__foo_bar_baz")).toBe("foo");
			expect(manager.resolveServerNameFromToolName("mcp__foo_bar")).toBe("foo");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("keeps a cache-miss pseudo-entry discoverable through pending readiness and hides it once ready", async () => {
		writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		try {
			await manager.discoverDeferred();
			// Cache-miss server starts discoverable.
			expect(manager.getDeferredDiscoverableTools().map(tool => tool.name)).toContain(
				createMCPServerToolName(DEFERRED_SERVER),
			);

			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => toolLoad.promise);

			const connect = manager.connectServerOnDemand(DEFERRED_SERVER);
			// Connection stored but listTools() still pending: the pseudo-entry must
			// remain discoverable so a cancelled search can retry and join it.
			await waitFor(
				() => manager.getConnection(DEFERRED_SERVER) !== undefined,
				"Timed out waiting for pending deferred connection",
			);
			expect(manager.getDeferredDiscoverableTools().map(tool => tool.name)).toContain(
				createMCPServerToolName(DEFERRED_SERVER),
			);

			toolLoad.resolve([LIVE_TOOL_DEF]);
			await connect;
			// Readiness completed with tools → pseudo-entry hidden.
			expect(manager.getDeferredDiscoverableTools().map(tool => tool.name)).not.toContain(
				createMCPServerToolName(DEFERRED_SERVER),
			);
		} finally {
			toolLoad.resolve([LIVE_TOOL_DEF]);
			await manager.disconnectAll();
		}
	});

	it("hides a cache-miss pseudo-entry for a ready server that exposes zero tools", async () => {
		writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		try {
			await manager.discoverDeferred();
			expect(manager.getDeferredDiscoverableTools().map(tool => tool.name)).toContain(
				createMCPServerToolName(DEFERRED_SERVER),
			);

			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			// A ready server that legitimately exposes no tools still completes
			// readiness, so its pseudo-entry must be hidden, not left dangling.
			listToolsSpy.mockResolvedValue([]);

			await manager.connectServerOnDemand(DEFERRED_SERVER);

			expect(manager.getConnection(DEFERRED_SERVER)).toBeDefined();
			expect(manager.getTools().filter(tool => tool.mcpServerName === DEFERRED_SERVER)).toEqual([]);
			expect(manager.getDeferredDiscoverableTools().map(tool => tool.name)).not.toContain(
				createMCPServerToolName(DEFERRED_SERVER),
			);
		} finally {
			await manager.disconnectAll();
		}
	});

	for (const disconnect of ["disconnectServer", "disconnectAll"] as const) {
		it(`does not publish pending tool readiness after ${disconnect}`, async () => {
			writeProjectMcpConfig(workDir);
			const manager = new MCPManager(workDir, new MCPToolCache(storage));
			const listStarted = Promise.withResolvers<void>();
			const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
			const onToolsChanged = mock(() => {});
			manager.setOnToolsChanged(onToolsChanged);
			try {
				await manager.discoverDeferred();
				connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
					mockConnectionFor(name, config),
				);
				listToolsSpy.mockImplementation(() => {
					listStarted.resolve();
					return toolLoad.promise;
				});

				const readinessResult = manager.connectServerOnDemand(DEFERRED_SERVER).then(
					() => undefined,
					error => error,
				);
				await listStarted.promise;
				expect(manager.getConnection(DEFERRED_SERVER)).toBeDefined();

				if (disconnect === "disconnectServer") {
					await manager.disconnectServer(DEFERRED_SERVER);
				} else {
					await manager.disconnectAll();
				}
				toolLoad.resolve([LIVE_TOOL_DEF]);

				const readinessError = await readinessResult;
				expect(readinessError).toBeInstanceOf(Error);
				expect(manager.getConnection(DEFERRED_SERVER)).toBeUndefined();
				expect(manager.getTools().filter(tool => tool.mcpServerName === DEFERRED_SERVER)).toEqual([]);
				expect(manager.getDiscoverableServerSummaries().some(summary => summary.name === DEFERRED_SERVER)).toBe(
					false,
				);
				expect(onToolsChanged).not.toHaveBeenCalled();
			} finally {
				toolLoad.resolve([LIVE_TOOL_DEF]);
				await manager.disconnectAll();
			}
		});
	}

	it("does not let a stale on-demand readiness attempt poison a same-name replacement", async () => {
		writeProjectMcpConfig(workDir);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const listLoads: Array<{
			promise: Promise<MCPToolDefinition[]>;
			resolve: (value: MCPToolDefinition[]) => void;
		}> = [];
		const oldListStarted = Promise.withResolvers<void>();
		const replacementListStarted = Promise.withResolvers<void>();
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => {
				const latch = Promise.withResolvers<MCPToolDefinition[]>();
				listLoads.push(latch);
				if (listLoads.length === 1) oldListStarted.resolve();
				if (listLoads.length === 2) replacementListStarted.resolve();
				return latch.promise;
			});

			const oldReady = manager.connectServerOnDemand(DEFERRED_SERVER).then(
				() => undefined,
				error => error,
			);
			await oldListStarted.promise;
			expect(connectSpy).toHaveBeenCalledTimes(1);

			await manager.disconnectServer(DEFERRED_SERVER);
			await manager.discoverDeferred();

			const replacementReady = manager.connectServerOnDemand(DEFERRED_SERVER);
			await replacementListStarted.promise;
			expect(connectSpy).toHaveBeenCalledTimes(2);
			expect(manager.getConnection(DEFERRED_SERVER)).toBeDefined();
			expect(manager.getServerError(DEFERRED_SERVER)).toBeUndefined();

			listLoads[0]?.resolve([LIVE_TOOL_DEF]);
			const oldOutcome = await oldReady;
			expect(oldOutcome).toBeInstanceOf(Error);
			expect(manager.getServerError(DEFERRED_SERVER)).toBeUndefined();
			let thirdSettled = false;
			const thirdReady = manager.connectServerOnDemand(DEFERRED_SERVER).finally(() => {
				thirdSettled = true;
			});
			expect(connectSpy).toHaveBeenCalledTimes(2);

			await Promise.resolve();
			expect(thirdSettled).toBe(false);

			listLoads[1]?.resolve([LIVE_TOOL_DEF]);
			await Promise.all([replacementReady, thirdReady]);
			expect(thirdSettled).toBe(true);

			expect(manager.getConnection(DEFERRED_SERVER)).toBeDefined();
			expect(manager.getTools().filter(tool => tool.mcpServerName === DEFERRED_SERVER)).toHaveLength(1);
			expect(manager.getServerError(DEFERRED_SERVER)).toBeUndefined();
		} finally {
			for (const latch of listLoads) latch.resolve([LIVE_TOOL_DEF]);
			await manager.disconnectAll();
		}
	});

	it("does not let an obsolete connection overwrite its same-name replacement's cache after hashing", async () => {
		const oldConfig = serverConfig(DEFERRED_SERVER, "Old deferred wiki server");
		if (oldConfig.type !== "stdio") throw new Error("Expected stdio test config");
		oldConfig.args = [DEFERRED_SERVER, "old"];
		fs.writeFileSync(
			path.join(workDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { [DEFERRED_SERVER]: oldConfig } }),
		);
		const toolCache = new MCPToolCache(storage);
		const manager = new MCPManager(workDir, toolCache);
		const oldTool: MCPToolDefinition = {
			...LIVE_TOOL_DEF,
			name: "old_lookup",
			description: "Obsolete tool schema",
		};
		const replacementTool: MCPToolDefinition = {
			...LIVE_TOOL_DEF,
			name: "replacement_lookup",
			description: "Replacement tool schema",
		};
		const connections: MCPServerConnection[] = [];
		const cacheWrites: Promise<void>[] = [];
		const originalCacheSet = toolCache.set.bind(toolCache);
		spyOn(toolCache, "set").mockImplementation((...args) => {
			const write = originalCacheSet(...args);
			cacheWrites.push(write);
			return write;
		});
		const setCacheSpy = spyOn(storage, "setCache");

		const blockedDigest = Promise.withResolvers<ArrayBuffer>();
		const oldDigestStarted = Promise.withResolvers<void>();
		const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
		let blockedFirstDigest = false;
		let releaseOldDigest = async (): Promise<void> => {};
		spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
			if (!blockedFirstDigest) {
				blockedFirstDigest = true;
				let released = false;
				releaseOldDigest = async () => {
					if (released) return;
					released = true;
					blockedDigest.resolve(await originalDigest(algorithm, data));
				};
				oldDigestStarted.resolve();
				return blockedDigest.promise;
			}
			return originalDigest(algorithm, data);
		});

		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => {
				const connection = mockConnectionFor(name, config);
				connections.push(connection);
				return connection;
			});
			listToolsSpy.mockImplementation(async connection =>
				connection === connections[0] ? [oldTool] : [replacementTool],
			);

			const oldReady = manager.connectServerOnDemand(DEFERRED_SERVER);
			await oldDigestStarted.promise;
			await oldReady;
			const oldOwnedConfig = manager.getServerConfig(DEFERRED_SERVER);
			if (!oldOwnedConfig) throw new Error("Expected the old manager-owned config");
			const oldOwnedConfigSnapshot = structuredClone(oldOwnedConfig);
			const oldCacheWrite = cacheWrites[0];
			if (!oldCacheWrite) throw new Error("Expected the old cache write to be pending");

			await manager.disconnectServer(DEFERRED_SERVER);
			const replacementConfig = serverConfig(DEFERRED_SERVER, "Replacement deferred wiki server");
			if (replacementConfig.type !== "stdio") throw new Error("Expected stdio test config");
			replacementConfig.args = [DEFERRED_SERVER, "replacement"];
			fs.writeFileSync(
				path.join(workDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { [DEFERRED_SERVER]: replacementConfig } }),
			);
			clearFsCache();
			await manager.discoverDeferred();
			await manager.connectServerOnDemand(DEFERRED_SERVER);
			const replacementOwnedConfig = manager.getServerConfig(DEFERRED_SERVER);
			if (!replacementOwnedConfig) throw new Error("Expected the replacement manager-owned config");
			expect(replacementOwnedConfig).not.toEqual(oldOwnedConfigSnapshot);
			const replacementCacheWrite = cacheWrites[1];
			if (!replacementCacheWrite) throw new Error("Expected the replacement cache write");
			await replacementCacheWrite;
			expect(setCacheSpy).toHaveBeenCalledTimes(1);

			await releaseOldDigest();
			await oldCacheWrite;
			expect(setCacheSpy).toHaveBeenCalledTimes(1);

			const freshCache = new MCPToolCache(storage);
			expect(await freshCache.get(DEFERRED_SERVER, replacementOwnedConfig)).toEqual([replacementTool]);
			expect(await freshCache.get(DEFERRED_SERVER, oldOwnedConfigSnapshot)).toBeNull();
		} finally {
			await releaseOldDigest();
			await Promise.all(cacheWrites);
			await manager.disconnectAll();
		}
	});

	it("search_tool_bm25 initially ranks a cached generic tool by server description without a pseudo-entry", async () => {
		const config = serverConfig(CACHED_SERVER, "Celestial archive knowledge");
		fs.writeFileSync(path.join(workDir, ".mcp.json"), JSON.stringify({ mcpServers: { [CACHED_SERVER]: config } }));
		const genericTool: MCPToolDefinition = {
			name: "search",
			description: "Run a query",
			inputSchema: { type: "object", properties: {} },
		};
		const toolCache = new MCPToolCache(storage);
		await toolCache.set(CACHED_SERVER, config, [genericTool]);
		const manager = new MCPManager(workDir, toolCache);
		try {
			const discovered = await manager.discoverDeferred();
			expect(manager.getDeferredDiscoverableTools()).toEqual([]);
			connectSpy.mockImplementation(async (name: string, liveConfig: MCPServerConfig) =>
				mockConnectionFor(name, liveConfig),
			);
			listToolsSpy.mockResolvedValue([genericTool]);
			const initialTool: DiscoverableTool = {
				name: `mcp__${CACHED_SERVER}_search`,
				label: `${CACHED_SERVER}/search`,
				summary: genericTool.description ?? "search",
				source: "mcp",
				serverName: CACHED_SERVER,
				mcpToolName: "search",
				schemaKeys: [],
			};
			expect(discovered.tools.map(tool => tool.name)).toEqual([initialTool.name]);
			const session = createBm25Session(manager, { discoverableTools: [initialTool] });

			const result = await new SearchToolBm25Tool(session).execute("cached-desc", {
				query: "celestial archive knowledge",
				limit: 5,
			});

			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(result.details?.activated_tools).toEqual([initialTool.name]);
			expect(result.details?.tools.map(match => match.name)).toContain(initialTool.name);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("search_tool_bm25 initially ranks an already-connected generic tool by server description", async () => {
		const config = serverConfig(CACHED_SERVER, "Celestial archive knowledge");
		fs.writeFileSync(path.join(workDir, ".mcp.json"), JSON.stringify({ mcpServers: { [CACHED_SERVER]: config } }));
		const genericTool: MCPToolDefinition = {
			name: "search",
			description: "Run a query",
			inputSchema: { type: "object", properties: {} },
		};
		connectSpy.mockImplementation(async (name: string, liveConfig: MCPServerConfig) =>
			mockConnectionFor(name, liveConfig),
		);
		listToolsSpy.mockResolvedValue([genericTool]);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		try {
			const discovered = await manager.discoverDeferred({ discoveryDefaultServers: [CACHED_SERVER] });
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(manager.getDeferredDiscoverableTools()).toEqual([]);
			const initialTool: DiscoverableTool = {
				name: `mcp__${CACHED_SERVER}_search`,
				label: `${CACHED_SERVER}/search`,
				summary: genericTool.description ?? "search",
				source: "mcp",
				serverName: CACHED_SERVER,
				mcpToolName: "search",
				schemaKeys: [],
			};
			expect(discovered.tools.map(tool => tool.name)).toEqual([initialTool.name]);
			const session = createBm25Session(manager, { discoverableTools: [initialTool] });

			const result = await new SearchToolBm25Tool(session).execute("connected-desc", {
				query: "celestial archive knowledge",
				limit: 5,
			});

			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(result.details?.activated_tools).toEqual([initialTool.name]);
			expect(result.details?.tools.map(match => match.name)).toContain(initialTool.name);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("search_tool_bm25 connects and activates a generic live tool matched only by server description", async () => {
		// Cache-miss server whose only query signal is its configured description;
		// its live tool name (`search`) does not contain the query terms.
		fs.writeFileSync(
			path.join(workDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					[DEFERRED_SERVER]: serverConfig(DEFERRED_SERVER, "Product documentation knowledge base"),
				},
			}),
		);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		try {
			await manager.discoverDeferred();
			expect(connectSpy).not.toHaveBeenCalled();

			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => {
				expect(name).toBe(DEFERRED_SERVER);
				return mockConnectionFor(name, config);
			});
			listToolsSpy.mockResolvedValue([
				{ name: "search", description: "Run a query", inputSchema: { type: "object", properties: {} } },
			]);

			// The pseudo-entry carries the server description in its summary so the
			// query matches before connect.
			const pseudo = manager.getDeferredDiscoverableTools();
			const session = createBm25Session(manager, { discoverableTools: pseudo });
			const tool = new SearchToolBm25Tool(session);

			const result = await tool.execute("call-desc-only", { query: "documentation knowledge base", limit: 5 });

			// Right server connected once, and the generic live tool ranked/activated
			// via the preserved description signal — both sinks, not just reconnect.
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(connectSpy.mock.calls[0]?.[0]).toBe(DEFERRED_SERVER);
			const liveToolName = `mcp__${DEFERRED_SERVER}_search`;
			expect(result.details?.activated_tools).toContain(liveToolName);
			expect(result.details?.tools.map(match => match.name)).toContain(liveToolName);
			expect(session.getSelectedMCPToolNames()).toContain(liveToolName);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("native user and project descriptions reach deferred prompts and BM25 without changing precedence", async () => {
		const userAgentDir = getAgentDir();
		const projectConfigDir = path.join(workDir, ".omp");
		fs.mkdirSync(userAgentDir, { recursive: true });
		fs.mkdirSync(projectConfigDir, { recursive: true });
		fs.writeFileSync(
			path.join(userAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					user_native: { command: "echo", description: "Celestial payroll records" },
					shared_native: { command: "echo", description: "User shared description" },
				},
			}),
		);
		fs.writeFileSync(
			path.join(projectConfigDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					project_native: { command: "echo", description: "Quantum issue tracker" },
					shared_native: { command: "echo", description: "Project shared description" },
					plain_native: { command: "echo" },
				},
			}),
		);
		clearFsCache();

		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		try {
			await manager.discoverDeferred();
			const summaries = manager.getDiscoverableServerSummaries();
			expect(summaries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "user_native", description: "Celestial payroll records" }),
					expect.objectContaining({ name: "project_native", description: "Quantum issue tracker" }),
					expect.objectContaining({ name: "shared_native", description: "Project shared description" }),
					expect.objectContaining({ name: "plain_native", description: undefined }),
				]),
			);
			expect(manager.getServerConfig("shared_native")?.description).toBe("Project shared description");

			const pseudo = manager.getDeferredDiscoverableTools();
			const plainPseudo = pseudo.find(tool => tool.serverName === "plain_native");
			expect(plainPseudo?.summary).toBe(
				'MCP server "plain_native" — tools not yet loaded; searching or calling loads them',
			);
			const promptDescription = renderSearchToolBm25Description(pseudo, summaries);
			expect(promptDescription).toContain("user_native (deferred) — Celestial payroll records");
			expect(promptDescription).toContain("project_native (deferred) — Quantum issue tracker");
			expect(promptDescription).toContain("plain_native (deferred)");
			expect(promptDescription).not.toContain("undefined");

			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockResolvedValue([
				{ name: "search", description: "Run a query", inputSchema: { type: "object", properties: {} } },
			]);
			const session = createBm25Session(manager, { discoverableTools: pseudo });
			const result = await new SearchToolBm25Tool(session).execute("native-description", {
				query: "celestial payroll records",
				limit: 5,
			});

			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(connectSpy.mock.calls[0]?.[0]).toBe("user_native");
			expect(result.details?.activated_tools).toContain("mcp__user_native_search");
			expect(result.details?.tools.map(match => match.name)).toContain("mcp__user_native_search");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("search_tool_bm25 retry after abort joins pending cache-miss readiness and activates", async () => {
		// Cache-miss server matched only by its configured description; its live
		// tool name (`search`) does not carry the query terms.
		fs.writeFileSync(
			path.join(workDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					[DEFERRED_SERVER]: serverConfig(DEFERRED_SERVER, "Product documentation knowledge base"),
				},
			}),
		);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const listStarted = Promise.withResolvers<void>();
		const toolLoad = Promise.withResolvers<MCPToolDefinition[]>();
		const liveToolDef: MCPToolDefinition = {
			name: "search",
			description: "Run a query",
			inputSchema: { type: "object", properties: {} },
		};
		const liveToolName = `mcp__${DEFERRED_SERVER}_search`;
		const query = "documentation knowledge base";
		const secondReachedManager = Promise.withResolvers<void>();
		let onDemandCalls = 0;
		try {
			await manager.discoverDeferred();
			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(() => {
				listStarted.resolve();
				return toolLoad.promise;
			});

			// Deterministic join probe: wrap the public connectServerOnDemand so we
			// can count how many searches actually reached the manager. This
			// distinguishes "second search joined pending readiness" from "retry has
			// not reached the connect path yet" — microtask draining alone cannot.
			const originalConnectServerOnDemand = manager.connectServerOnDemand.bind(manager);
			spyOn(manager, "connectServerOnDemand").mockImplementation((name, signal) => {
				onDemandCalls++;
				if (onDemandCalls === 2) secondReachedManager.resolve();
				return originalConnectServerOnDemand(name, signal);
			});

			// ONE session/tool, sourced from the cache-miss pseudo-entry.
			const session = createBm25Session(manager, {
				discoverableTools: manager.getDeferredDiscoverableTools(),
			});
			const tool = new SearchToolBm25Tool(session);

			// First search: connect resolves, listTools latches, then the caller aborts.
			const controller = new AbortController();
			const firstSearch = tool.execute("call-abort", { query, limit: 5 }, controller.signal);
			await listStarted.promise;
			expect(onDemandCalls).toBe(1);
			controller.abort(new DOMException("cancelled", "AbortError"));
			await expect(firstSearch).rejects.toMatchObject({ name: "AbortError" });

			// Readiness is still pending (listTools latched), so the manager keeps the
			// pseudo-entry discoverable — proving the cancelled search can retry from it.
			expect(manager.getConnection(DEFERRED_SERVER)).toBeDefined();
			expect(manager.getDeferredDiscoverableTools().map(entry => entry.name)).toContain(
				createMCPServerToolName(DEFERRED_SERVER),
			);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);

			// Second search on the SAME session. Await the wrapper's 2nd invocation
			// (a real causal signal, not a timer) to prove the retry reached the
			// manager, then assert it joined the shared readiness: the transport
			// connect/list stay at 1 and the search stays pending.
			let secondSettled = false;
			const secondSearch = tool.execute("call-retry", { query, limit: 5 }).then(result => {
				secondSettled = true;
				return result;
			});
			await secondReachedManager.promise;
			expect(onDemandCalls).toBe(2);
			expect(secondSettled).toBe(false);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);

			// Release the joined readiness: tools load once and the retry ranks +
			// activates the now-live generic tool via the preserved description signal.
			toolLoad.resolve([liveToolDef]);
			const result = await secondSearch;
			expect(secondSettled).toBe(true);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(listToolsSpy).toHaveBeenCalledTimes(1);
			expect(result.details?.activated_tools).toContain(liveToolName);
			expect(result.details?.tools.map(match => match.name)).toContain(liveToolName);
			expect(session.getSelectedMCPToolNames()).toContain(liveToolName);
			expect(manager.getDeferredDiscoverableTools().map(entry => entry.name)).not.toContain(
				createMCPServerToolName(DEFERRED_SERVER),
			);
		} finally {
			toolLoad.resolve([liveToolDef]);
			await manager.disconnectAll();
		}
	});

	it("resolves both-live normalized-name collisions to the callable registry owner", async () => {
		// Ambiguous namespace: server `foo` tool `bar_baz` and server `foo_bar`
		// tool `baz` both normalize to `mcp__foo_bar_baz`. AgentSession registers
		// manager tools into a Map in array order, so the last exact entry is callable.
		const fooConfig = serverConfig("foo", "Foo server");
		const fooBarConfig = serverConfig("foo_bar", "Foo bar server");
		fs.writeFileSync(
			path.join(workDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { foo: fooConfig, foo_bar: fooBarConfig } }),
		);
		const manager = new MCPManager(workDir, new MCPToolCache(storage));
		const collisionName = "mcp__foo_bar_baz";
		try {
			await manager.discoverDeferred();
			// Preserve uncached fallback: the longest configured server prefix wins
			// before any exact tool metadata exists.
			expect(manager.resolveServerNameFromToolName("mcp__foo_bar")).toBe("foo");
			expect(manager.resolveServerNameFromToolName(collisionName)).toBe("foo_bar");

			connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) =>
				mockConnectionFor(name, config),
			);
			listToolsSpy.mockImplementation(async (connection: MCPServerConnection) =>
				connection.name === "foo"
					? [{ name: "bar_baz", description: "Foo collision", inputSchema: { type: "object", properties: {} } }]
					: [{ name: "baz", description: "Foo bar collision", inputSchema: { type: "object", properties: {} } }],
			);
			await manager.discoverAndConnect();

			const exactOwners = manager
				.getTools()
				.filter(tool => tool.name === collisionName)
				.map(tool => tool.mcpServerName);
			expect(exactOwners).toEqual(["foo", "foo_bar"]);
			const callableOwner = await getCallableMCPToolOwner(workDir, manager.getTools(), collisionName);
			expect(callableOwner).toBe("foo_bar");
			expect(manager.resolveServerNameFromToolName(collisionName)).toBe(callableOwner);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("resolves both-cached normalized-name collisions to the callable registry owner", async () => {
		const fooConfig = serverConfig("foo", "Foo server");
		const fooBarConfig = serverConfig("foo_bar", "Foo bar server");
		fs.writeFileSync(
			path.join(workDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { foo: fooConfig, foo_bar: fooBarConfig } }),
		);
		const toolCache = new MCPToolCache(storage);
		await toolCache.set("foo", fooConfig, [
			{ name: "bar_baz", description: "Cached foo collision", inputSchema: { type: "object", properties: {} } },
		]);
		await toolCache.set("foo_bar", fooBarConfig, [
			{ name: "baz", description: "Cached foo bar collision", inputSchema: { type: "object", properties: {} } },
		]);
		const manager = new MCPManager(workDir, toolCache);
		const collisionName = "mcp__foo_bar_baz";
		try {
			await manager.discoverDeferred();

			const exactOwners = manager
				.getTools()
				.filter(tool => tool.name === collisionName)
				.map(tool => tool.mcpServerName);
			expect(exactOwners).toEqual(["foo", "foo_bar"]);
			const callableOwner = await getCallableMCPToolOwner(workDir, manager.getTools(), collisionName);
			expect(callableOwner).toBe("foo_bar");
			expect(manager.resolveServerNameFromToolName(collisionName)).toBe(callableOwner);
			expect(connectSpy).not.toHaveBeenCalled();
		} finally {
			await manager.disconnectAll();
		}
	});
});
