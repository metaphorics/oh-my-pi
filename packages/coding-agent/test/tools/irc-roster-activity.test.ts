import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { IrcTool } from "@oh-my-pi/pi-coding-agent/tools/irc";

// Contract: the work-aware roster (`irc list`) surfaces each peer's role
// (via displayName) and current activity gist, and a peer with no activity
// renders cleanly without a dangling empty clause.

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

async function listText(registry: AgentRegistry, selfId: string): Promise<string> {
	const tool = new IrcTool(makeToolSession(registry, selfId));
	const result = await tool.execute("call", { op: "list" });
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("IRC roster activity", () => {
	let registry: AgentRegistry;
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("surfaces a peer's role and current activity in the list", async () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "AuthScout",
			displayName: "Auth-flow security reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});
		registry.setActivity("AuthScout", "auditing the token refresh path");

		const text = await listText(registry, "Main");
		expect(text).toContain("Auth-flow security reviewer");
		expect(text).toContain("auditing the token refresh path");
	});

	it("renders a peer with no activity without a dangling clause", async () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({ id: "Quiet", displayName: "task", kind: "sub", session: null, status: "running" });

		const text = await listText(registry, "Main");
		const line = text.split("\n").find(l => l.includes("Quiet"));
		expect(line).toBeDefined();
		expect(line).not.toContain("— ,");
		expect(line).not.toContain("undefined");
	});

	it("setActivity is a no-op for an unknown agent id", () => {
		expect(() => registry.setActivity("Ghost", "noop")).not.toThrow();
	});
});
