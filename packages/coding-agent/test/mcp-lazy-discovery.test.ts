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
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createMCPServerToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
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
	return {
		cwd: "/tmp/lazy-mcp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "mcp.lazyDiscovery": true, "mcp.discoveryMode": true }),
		isMCPDiscoveryEnabled: () => true,
		getDiscoverableTools: () => discoverableTools,
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
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
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
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
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
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
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
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
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
});
