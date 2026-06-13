import { describe, expect, it } from "bun:test";
import { taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import { getTaskSchema, resolveSubagentDisplayName, subagentRoleLabel } from "@oh-my-pi/pi-coding-agent/task/types";
import { prompt } from "@oh-my-pi/pi-utils";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

// Contract: a per-spawn `role` gives a subagent a tailored identity. The role
// becomes its registry/roster display name and is injected as a system-prompt
// specialization preamble; an absent/blank role falls back to the agent type.

describe("resolveSubagentDisplayName", () => {
	it("uses the role as the display name when one is given", () => {
		expect(resolveSubagentDisplayName("Rust async-runtime specialist", "task")).toBe("Rust async-runtime specialist");
	});

	it("falls back to the agent name for an absent role", () => {
		expect(resolveSubagentDisplayName(undefined, "task")).toBe("task");
	});

	it("falls back to the agent name for an empty or whitespace role", () => {
		expect(resolveSubagentDisplayName("", "explore")).toBe("explore");
		expect(resolveSubagentDisplayName("   \n\t ", "explore")).toBe("explore");
	});

	it("collapses internal whitespace so a multi-line role stays one roster line", () => {
		expect(resolveSubagentDisplayName("Auth\n  flow   reviewer", "task")).toBe("Auth flow reviewer");
	});

	it("caps an overlong role label with an ellipsis", () => {
		const long = "x".repeat(200);
		const label = resolveSubagentDisplayName(long, "task");
		expect(label.length).toBe(80);
		expect(label.endsWith("…")).toBe(true);
	});
});

describe("subagentRoleLabel", () => {
	it("returns short roles unchanged", () => {
		expect(subagentRoleLabel("DB migration specialist")).toBe("DB migration specialist");
	});
});

describe("subagent system prompt role preamble", () => {
	function render(role: string): string {
		return prompt.render(subagentSystemPromptTemplate, { agent: "Base worker body.", role });
	}

	it("injects the specialization preamble when a role is provided", () => {
		const out = render("Rust async-runtime specialist");
		expect(out).toContain("specializing as: **Rust async-runtime specialist**");
	});

	it("omits the preamble entirely when the role is blank", () => {
		expect(render("")).not.toContain("specializing as");
	});
});

describe("task schema accepts role", () => {
	it("keeps role on the flat single-spawn shape", () => {
		const parsed = taskSchema.safeParse({ agent: "task", assignment: "x", role: "Rust specialist" });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.role).toBe("Rust specialist");
		}
	});

	it("keeps role on batch task items", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const parsed = batch.safeParse({
			agent: "task",
			context: "ctx",
			tasks: [{ assignment: "x", role: "DB migration specialist" }],
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && "tasks" in parsed.data) {
			const tasks = parsed.data.tasks as Array<{ role?: string }>;
			expect(tasks[0]?.role).toBe("DB migration specialist");
		}
	});
});
