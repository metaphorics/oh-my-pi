import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
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

const RAW_SERVER_URL = `https://\${MCP_HOST}/mcp`;
const EXPANDED_SERVER_URL = "https://mcp.example.com/mcp";
const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
);

type TestConfigFile = {
	mcpServers?: Record<string, MCPServerConfig>;
};

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreEnvValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		delete process.env[name];
		return;
	}
	Bun.env[name] = value;
	process.env[name] = value;
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

function createController(
	authStorage: AuthStorage,
	mcpManagerOverrides: Record<string, unknown> = {},
	settings: Settings = Settings.isolated(),
) {
	const showError = vi.fn();
	const showStatus = vi.fn();
	const present = vi.fn();
	const editor: { onEscape?: () => void } = {};
	const prepareConfig = vi.fn(async (config: MCPServerConfig) => config);
	const mcpManager = {
		prepareConfig,
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => ({ errors: new Map<string, string>() })),
		discoverDeferred: vi.fn(async () => ({ errors: new Map<string, string>() })),
		connectServerOnDemand: vi.fn(async (_name: string) => {}),
		getServerConfig: vi.fn(() => undefined as MCPServerConfig | undefined),
		getTools: vi.fn(() => []),
		waitForConnection: vi.fn(async () => {}),
		getConnectionStatus: vi.fn(() => "connected"),
		...mcpManagerOverrides,
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present,
		ui: { requestRender: vi.fn() },
		editor,
		showError,
		showStatus,
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session: {
			refreshMCPTools: vi.fn(),
			modelRegistry: { authStorage },
		},
		settings,
		mcpManager,
	} as never);

	return { controller, showError, showStatus, present, editor, prepareConfig, mcpManager };
}

describe("/mcp auth commands", () => {
	let projectDir = "";
	let agentDir = "";
	let configPath = "";
	let originalMcpHost: string | undefined;
	// Track every in-memory auth store so afterEach can close the underlying
	// bun:sqlite Database. Leaked Database handles are JSDestructibleObjects that
	// JSC otherwise finalizes during an arbitrary later GC sweep — under
	// `bun test --parallel` that sweep can run mid-suite on the shared VM and
	// trip a Bun GC crash (SIGABRT "Pure virtual function called").
	const openAuthStores: AuthStorage[] = [];
	function freshAuthStorage(): AuthStorage {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		openAuthStores.push(storage);
		return storage;
	}

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-agent-"));
		configPath = path.join(projectDir, ".mcp.json");
		originalMcpHost = Bun.env.MCP_HOST;
		Bun.env.MCP_HOST = "mcp.example.com";
		process.env.MCP_HOST = "mcp.example.com";
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						envserver: {
							type: "http",
							url: RAW_SERVER_URL,
						},
					},
				},
				null,
				2,
			)}\n`,
		);
	});

	afterEach(async () => {
		while (openAuthStores.length > 0) openAuthStores.pop()?.close();
		vi.restoreAllMocks();
		restoreEnvValue("MCP_HOST", originalMcpHost);
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("stores definition-only OAuth credentials under the expanded URL key", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError, prepareConfig } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(prepareConfig).toHaveBeenCalledWith(
			expect.objectContaining({ url: EXPANDED_SERVER_URL }),
			expect.objectContaining({ oauth: false }),
		);
		expect(connectToServer).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ url: EXPANDED_SERVER_URL }),
		);
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			tokenUrl: "https://auth.example.com/token",
			resource: EXPANDED_SERVER_URL,
		});
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL))).toBeUndefined();

		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedServer = saved.mcpServers?.envserver;
		const savedUrl = savedServer?.type === "http" || savedServer?.type === "sse" ? savedServer.url : undefined;
		expect(savedUrl).toBe(RAW_SERVER_URL);
		expect(savedServer?.auth).toBeUndefined();
	});

	test("lazy reauth rediscovers deferred and connects only the target server", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const discoverDeferred = vi.fn(async () => ({
			errors: new Map<string, string>(),
			connectedServers: [] as string[],
			tools: [],
			exaApiKeys: [] as string[],
		}));
		const connectServerOnDemand = vi.fn(async (_name: string) => {});
		const discoverAndConnect = vi.fn(async () => ({ errors: new Map<string, string>() }));
		const { controller, showError } = createController(
			authStorage,
			{
				discoverDeferred,
				connectServerOnDemand,
				discoverAndConnect,
				// The just-reauthed server is configured after deferred rediscovery, so
				// the targeted on-demand connect path is eligible.
				getServerConfig: vi.fn((name: string) =>
					name === "envserver" ? { type: "http", url: EXPANDED_SERVER_URL } : undefined,
				),
			},
			Settings.isolated({ "mcp.lazyDiscovery": true }),
		);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		// Lazy policy: rediscover deferred (no eager fan-out), then connect only
		// the reauthed target on demand.
		expect(discoverDeferred).toHaveBeenCalledTimes(1);
		expect(discoverAndConnect).not.toHaveBeenCalled();
		expect(connectServerOnDemand).toHaveBeenCalledTimes(1);
		expect(connectServerOnDemand.mock.calls[0]?.[0]).toBe("envserver");
	});

	test("lazy reauth surfaces a targeted connection rejection", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const connectError = new Error("targeted reauth connection failed");
		const connectServerOnDemand = vi.fn(async () => {
			throw connectError;
		});
		const { controller, present, mcpManager } = createController(
			authStorage,
			{
				connectServerOnDemand,
				getServerConfig: vi.fn((name: string) =>
					name === "envserver" ? { type: "http", url: EXPANDED_SERVER_URL } : undefined,
				),
			},
			Settings.isolated({ "mcp.lazyDiscovery": true }),
		);

		await controller.handle("/mcp reauth envserver");

		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(connectServerOnDemand).toHaveBeenCalledWith("envserver");
		const output = renderPresented(present.mock.calls);
		expect(output).toContain("Some servers failed to connect:");
		expect(output).toContain("envserver: targeted reauth connection failed");
	});

	test("reuses embedded DCR client secret during reauth token exchange", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 3_600_000,
			tokenUrl: "https://auth.example.com/token",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
			resource: EXPANDED_SERVER_URL,
		} as oauthFlow.MCPStoredOAuthCredential);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "fresh-access",
					refresh_token: "fresh-refresh",
					expires_in: 3600,
					token_type: "Bearer",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			return this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
		});
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		const tokenRequestBody = String(fetchSpy.mock.calls[0]?.[1]?.body ?? "");
		const tokenRequest = new URLSearchParams(tokenRequestBody);
		expect(tokenRequest.get("client_id")).toBe("dcr-client");
		expect(tokenRequest.get("client_secret")).toBe("dcr-secret");
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
		});
	});

	test("Esc aborts the OAuth flow during /mcp reauth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Simulate the real flow: login hangs waiting for the OAuth callback and
		// only resolves when the controller's signal aborts. Mirrors what
		// OAuthCallbackFlow.#waitForCallback does in production.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			const pending = Promise.withResolvers<never>();
			this.ctrl.signal?.addEventListener("abort", () => {
				pending.reject(new Error(`OAuth callback cancelled: ${String(this.ctrl.signal?.reason ?? "aborted")}`));
			});
			return pending.promise;
		});

		const { controller, showError, showStatus, editor } = createController(authStorage);

		const reauthPromise = controller.handle("/mcp reauth envserver");

		// Wait for #handleOAuthFlow to install its editor.onEscape hook.
		const deadline = Date.now() + 1_000;
		while (typeof editor.onEscape !== "function" && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		expect(typeof editor.onEscape).toBe("function");

		const installedEscape = editor.onEscape;
		editor.onEscape?.();

		// Cancellation must resolve the reauth promise promptly (well under the
		// 5-minute production timeout); a 2s race exposes a hung flow as a test
		// failure rather than a suite hang.
		await Promise.race([
			reauthPromise,
			Bun.sleep(2_000).then(() => {
				throw new Error("reauth did not resolve within 2s of Esc");
			}),
		]);

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		// onEscape must be restored to its previous value so subsequent user
		// input does not keep aborting the (now-finished) flow.
		expect(editor.onEscape).not.toBe(installedEscape);
	});

	test("Esc cancels even when OAuth login has not registered its signal listener yet", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Simulates the review race: Esc aborts oauthTimeout before
		// OAuthCallbackFlow.#waitForCallback has registered its abort listener
		// (e.g. during dynamic client registration or metadata discovery).
		// The login promise itself never observes ctrl.signal; #handleOAuthFlow
		// must race it against oauthTimeout.signal.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockReturnValue(Promise.withResolvers<never>().promise);
		const { controller, showError, showStatus, editor } = createController(authStorage);

		const reauthPromise = controller.handle("/mcp reauth envserver");
		const deadline = Date.now() + 1_000;
		while (typeof editor.onEscape !== "function" && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		expect(typeof editor.onEscape).toBe("function");
		editor.onEscape?.();

		await Promise.race([
			reauthPromise,
			Bun.sleep(2_000).then(() => {
				throw new Error("reauth did not resolve within 2s of pre-wait Esc");
			}),
		]);

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
	});

	test("OAuth deadline still surfaces as a reauthorization error, not a cancellation", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Deadline path bypasses both the editor's Esc hook and any external
		// signal: withTimeout aborts the controller with reason "MCP OAuth flow
		// timed out" and the login promise rejects with a "timed out" message.
		// Mirror that here. Keeping the surface distinct from the user-cancel
		// flag in #handleOAuthFlow is the whole point of this regression test.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockRejectedValue(
			new Error("OAuth flow timed out after 5 minutes"),
		);
		const { controller, showError, showStatus } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		// Deadline must read as "failed", not "cancelled" — they have different
		// surfaces (error banner vs status line) and the user expects a clear
		// timeout message rather than thinking they pressed Esc.
		expect(showStatus).not.toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		expect(showError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
	});

	test("clears both expanded and stale raw URL-keyed credentials on unauth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "expanded-access",
			refresh: "expanded-refresh",
			expires: Date.now() + 3_600_000,
		});
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL), {
			type: "oauth",
			access: "raw-access",
			refresh: "raw-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp unauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL))).toBeUndefined();
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedServer = saved.mcpServers?.envserver;
		const savedUrl = savedServer?.type === "http" || savedServer?.type === "sse" ? savedServer.url : undefined;
		expect(savedUrl).toBe(RAW_SERVER_URL);
		expect(savedServer?.auth).toBeUndefined();
	});

	test("lazy unauth rediscovers deferred without reconnecting any server", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "expanded-access",
			refresh: "expanded-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, mcpManager } = createController(
			authStorage,
			{
				// If unauth accidentally passed a target, this config would make the
				// targeted connection observable.
				getServerConfig: vi.fn(() => ({ type: "http", url: EXPANDED_SERVER_URL })),
			},
			Settings.isolated({ "mcp.lazyDiscovery": true }),
		);

		await controller.handle("/mcp unauth envserver");

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
	});

	test("clears url-keyed auth for discovered definition-only servers", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "discovered-access",
			refresh: "discovered-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError, mcpManager } = createController(
			authStorage,
			{
				getServerConfig: vi.fn(() => ({ type: "http", url: EXPANDED_SERVER_URL })),
				getSource: vi.fn(() => ({ provider: "test", path: "/tmp/discovered.json" })),
			},
			Settings.isolated({ "mcp.lazyDiscovery": true }),
		);

		await controller.handle("/mcp unauth discovered");

		expect(showError).not.toHaveBeenCalled();
		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverDeferred).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServerOnDemand).not.toHaveBeenCalled();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		const userConfigPath = getMCPConfigPath("user", projectDir);
		const userConfig = JSON.parse(
			await Bun.file(userConfigPath)
				.text()
				.catch(() => "{}"),
		) as TestConfigFile;
		expect(userConfig.mcpServers?.discovered).toBeUndefined();
	});
});
