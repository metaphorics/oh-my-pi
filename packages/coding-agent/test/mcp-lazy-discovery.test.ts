/**
 * Contracts for T6 lazy MCP discovery (`mcp.lazyDiscovery`):
 *
 * 1. `discoverDeferred` loads cached schemas without calling `connectToServer`.
 * 2. Server summaries mark cached vs deferred (cache-miss) servers for prompts.
 * 3. `search_tool_bm25` matching a cached lazy tool connects that server once
 *    and activates the real tool after refresh.
 * 4. A failing on-demand connect surfaces `server "<name>" unavailable: …`.
 * 5. Eager `discoverAndConnect` still connects at discovery time.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	type DiscoverableTool,
	formatDiscoverableToolServerSummary,
} from "@oh-my-pi/pi-coding-agent/tool-discovery/tool-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { renderSearchToolBm25Description, SearchToolBm25Tool } from "@oh-my-pi/pi-coding-agent/tools/search-tool-bm25";
import { getAgentDir, removeSyncWithRetries, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";
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

describe("lazy MCP discovery (T6)", () => {
	let workDir: string;
	let isolatedHome: string;
	let originalAgentDir: string;
	let storage: AgentStorage;
	let connectSpy: ReturnType<typeof spyOn>;
	let listToolsSpy: ReturnType<typeof spyOn>;
	let homedirSpy: ReturnType<typeof spyOn>;

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
			expect(deferredNames).toContain(`mcp__${DEFERRED_SERVER}`);
			expect(deferredNames).not.toContain(`mcp__${CACHED_SERVER}_lookup_docs`);
			const deferredEntry = deferredPseudo.find(tool => tool.serverName === DEFERRED_SERVER);
			expect(deferredEntry?.deferredServer).toBe(true);
			expect(deferredEntry?.summary).toBe("Deferred wiki server");
		} finally {
			await manager.disconnectAll();
		}
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
					name: `mcp__${DEFERRED_SERVER}`,
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
