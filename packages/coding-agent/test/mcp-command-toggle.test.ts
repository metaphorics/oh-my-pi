import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpConfigWriter from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPLoadResult } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.PI_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	delete Bun.env.PI_CODING_AGENT_DIR;
}

function emptyLoadResult(): MCPLoadResult {
	return { errors: new Map<string, string>(), connectedServers: [], tools: [], exaApiKeys: [] };
}

type Renderable = { render(width: number): readonly string[] };

function isRenderable(value: unknown): value is Renderable {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

function renderPresented(calls: readonly (readonly unknown[])[]): string {
	const lines: string[] = [];
	for (const [content] of calls) {
		const components = Array.isArray(content) ? content : [content];
		for (const component of components) {
			if (isRenderable(component)) lines.push(...component.render(120));
		}
	}
	return Bun.stripANSI(lines.join("\n"));
}

function createController(options: { settings?: Settings; mcpManagerExtra?: Record<string, unknown> } = {}) {
	const refreshMCPTools = vi.fn(async () => {});
	const present = vi.fn();
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => emptyLoadResult()),
		discoverDeferred: vi.fn(async () => emptyLoadResult()),
		connectServerOnDemand: vi.fn(async (_name: string) => {}),
		disconnectServer: vi.fn(async () => {}),
		connectServers: vi.fn(
			async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
				errors: new Map<string, string>(),
				connectedServers: [],
				tools: [],
				exaApiKeys: [],
			}),
		),
		getTools: vi.fn(() => []),
		getServerConfig: vi.fn(() => undefined as MCPServerConfig | undefined),
		getConnection: vi.fn(() => undefined),
		getConnectedServers: vi.fn(() => [] as string[]),
		waitForConnection: vi.fn(async () => ({})),
		getConnectionStatus: vi.fn(() => "connected"),
		getSource: vi.fn(() => undefined),
		...options.mcpManagerExtra,
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present,
		ui: { requestRender: vi.fn() },
		editor: {},
		showError: vi.fn(),
		showStatus: vi.fn(),
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session: {
			refreshMCPTools,
			modelRegistry: { authStorage: undefined },
			getActiveToolNames: vi.fn(() => [] as string[]),
			getToolByName: vi.fn(() => undefined),
			setActiveToolsByName: vi.fn(async () => {}),
		},
		settings: options.settings ?? Settings.isolated(),
		mcpManager,
	} as never);

	return { controller, mcpManager, refreshMCPTools, present };
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

describe("/mcp enable and disable", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("disabling one configured server does not reload other MCP servers", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("mcp1");
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
	});

	test("enabling one configured server connects only that MCP server", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).toHaveBeenCalledTimes(1);
		const [configs] = mcpManager.connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});
});

describe("/mcp reload and add honor mcp.lazyDiscovery", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-lazyreload-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-lazyreload-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("lazy /mcp reload rediscovers deferred without eager or targeted connects", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController({
			settings: Settings.isolated({ "mcp.lazyDiscovery": true }),
		});

		await controller.handle("/mcp reload");

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		// Zero eager connects: neither the eager discovery path nor any on-demand
		// connect may fire for a plain reload under lazy discovery.
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
		expect(refreshMCPTools).toHaveBeenCalledTimes(1);
	});

	test("lazy /mcp reload connects configured defaults while leaving non-defaults deferred", async () => {
		await writeProjectConfig(projectDir, {
			defaulted: { type: "stdio", command: "default-server" },
			deferred: { type: "stdio", command: "deferred-server" },
		});
		const { controller, mcpManager } = createController({
			settings: Settings.isolated({
				"mcp.lazyDiscovery": true,
				"mcp.discoveryDefaultServers": ["  defaulted  ", "", "   "],
			}),
		});

		await controller.handle("/mcp reload");

		expect(mcpManager.discoverDeferred).toHaveBeenCalledWith({
			discoveryDefaultServers: ["defaulted"],
		});
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
	});

	test("eager /mcp reload still uses discoverAndConnect", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
		});
		const { controller, mcpManager } = createController({
			settings: Settings.isolated({ "mcp.lazyDiscovery": false }),
		});

		await controller.handle("/mcp reload");

		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverDeferred).not.toHaveBeenCalled();
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
	});

	test("lazy /mcp add connects only the added target after deferred rediscovery", async () => {
		const addedConfig: MCPServerConfig = { type: "stdio", command: "new-server" };
		const { controller, mcpManager } = createController({
			settings: Settings.isolated({ "mcp.lazyDiscovery": true }),
			// After rediscovery the added server is configured, so the targeted
			// connect path is eligible; getConnectionStatus stays "connected" so
			// the status animation resolves without a live transport.
			mcpManagerExtra: {
				getServerConfig: vi.fn((name: string) => (name === "newsrv" ? addedConfig : undefined)),
			},
		});

		await controller.handle("/mcp add newsrv -- new-server");

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		// Only the just-added server connects on demand — no eager fan-out.
		expect(mcpManager.connectServerOnDemand).toHaveBeenCalledTimes(1);
		expect(mcpManager.connectServerOnDemand.mock.calls[0]?.[0]).toBe("newsrv");

		const saved = JSON.parse(await Bun.file(getMCPConfigPath("project", projectDir)).text()) as {
			mcpServers?: Record<string, MCPServerConfig>;
		};
		expect(saved.mcpServers?.newsrv).toMatchObject({ type: "stdio", command: "new-server" });
	});

	test("lazy /mcp add does not reconnect a target already handled as a discovery default", async () => {
		const addedConfig: MCPServerConfig = { type: "stdio", command: "new-server" };
		const defaultError = "default target connection failed";
		const { controller, mcpManager, present } = createController({
			settings: Settings.isolated({
				"mcp.lazyDiscovery": true,
				"mcp.discoveryDefaultServers": ["  newsrv  "],
			}),
			mcpManagerExtra: {
				discoverDeferred: vi.fn(async () => ({
					...emptyLoadResult(),
					errors: new Map([["newsrv", defaultError]]),
				})),
				getServerConfig: vi.fn((name: string) => (name === "newsrv" ? addedConfig : undefined)),
			},
		});

		await controller.handle("/mcp add newsrv -- new-server");

		expect(mcpManager.discoverDeferred).toHaveBeenCalledWith({
			discoveryDefaultServers: ["newsrv"],
		});
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
		const output = renderPresented(present.mock.calls);
		expect(output).toContain("Some servers failed to connect:");
		expect(output).toContain(`newsrv: ${defaultError}`);
	});

	test("lazy /mcp add surfaces a targeted connection rejection", async () => {
		const addedConfig: MCPServerConfig = { type: "stdio", command: "new-server" };
		const connectError = new Error("targeted add connection failed");
		const { controller, mcpManager, present } = createController({
			settings: Settings.isolated({ "mcp.lazyDiscovery": true }),
			mcpManagerExtra: {
				getServerConfig: vi.fn((name: string) => (name === "newsrv" ? addedConfig : undefined)),
				connectServerOnDemand: vi.fn(async () => {
					throw connectError;
				}),
				getConnectionStatus: vi.fn(() => "connecting"),
			},
		});

		await controller.handle("/mcp add newsrv -- new-server");

		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServerOnDemand).toHaveBeenCalledWith("newsrv");
		const output = renderPresented(present.mock.calls);
		expect(output).toContain("Some servers failed to connect:");
		expect(output).toContain("newsrv: targeted add connection failed");
	});

	test("lazy /mcp add leaves a disabled server deferred without connecting it", async () => {
		const addMCPServer = mcpConfigWriter.addMCPServer;
		vi.spyOn(mcpConfigWriter, "addMCPServer").mockImplementation(async (filePath, name, config) => {
			// Exercise #handleWizardComplete's real disabled-config branch: the writer
			// receives the same config object that chooses the subsequent reload target.
			config.enabled = false;
			await addMCPServer(filePath, name, config);
		});
		const { controller, mcpManager } = createController({
			settings: Settings.isolated({ "mcp.lazyDiscovery": true }),
			mcpManagerExtra: {
				// Keep the target resolvable so mutating the caller to always pass `name`
				// would perform a targeted connect and fail this regression.
				getServerConfig: vi.fn(() => ({ type: "stdio", command: "should-not-connect" })),
				getConnectionStatus: vi.fn(() => "connecting"),
			},
		});

		await controller.handle("/mcp add disabledsrv -- disabled-server");

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
		const saved = JSON.parse(await Bun.file(getMCPConfigPath("project", projectDir)).text()) as {
			mcpServers?: Record<string, MCPServerConfig>;
		};
		expect(saved.mcpServers?.disabledsrv?.enabled).toBe(false);
	});

	test("lazy /mcp remove rediscovers deferred without reconnecting any server", async () => {
		await writeProjectConfig(projectDir, {
			removed: { type: "stdio", command: "removed-server" },
			remaining: { type: "stdio", command: "remaining-server" },
		});
		const { controller, mcpManager } = createController({
			settings: Settings.isolated({ "mcp.lazyDiscovery": true }),
			// If remove accidentally passed a target, this live config would make the
			// targeted connection observable.
			mcpManagerExtra: {
				getServerConfig: vi.fn(() => ({ type: "stdio", command: "should-not-connect" })),
			},
		});

		await controller.handle("/mcp remove removed");

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
	});
});
