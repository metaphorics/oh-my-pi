import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let counter = 0;
function makeNode(role: "user" | "assistant", text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${counter++}`;
	const message: AgentMessage =
		role === "user"
			? { role: "user", content: text, timestamp: counter }
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					timestamp: counter,
					stopReason: "stop",
				} as AgentMessage);
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function renderStripped(tree: SessionTreeNode[], leafId: string, width = 120): string[] {
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		60,
		() => {},
		() => {},
	);
	return selector.render(width).map(line => Bun.stripANSI(line));
}

describe("issue #2298: chain rows under last-sibling branches keep their gutter", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	// Branched grandchildren and their continuations must stay on the standard
	// tree convention so a `│` never floats below an unrelated `└─`. Only the
	// nearest connector gutter is extended for chain rows.
	it("does not extend the gutter through branched descendants of a last-sibling parent", () => {
		const root = makeNode("user", "original");
		const rootAsst = makeNode("assistant", "resp", root.entry.id);
		root.children.push(rootAsst);

		const branch1 = makeNode("user", "branch1 head", rootAsst.entry.id);
		const branch2 = makeNode("user", "branch2 head", rootAsst.entry.id);
		rootAsst.children.push(branch1, branch2);

		// branch1 itself branches into c, d (both have their own connectors),
		// and each grandchild continues linearly.
		const c = makeNode("user", "grandchild c", branch1.entry.id);
		const d = makeNode("user", "grandchild d", branch1.entry.id);
		branch1.children.push(c, d);
		const cContinuation = makeNode("assistant", "c continuation", c.entry.id);
		c.children.push(cContinuation);
		const dContinuation = makeNode("assistant", "d continuation", d.entry.id);
		d.children.push(dContinuation);

		const fixIt = makeNode("user", "fix it all", branch2.entry.id);
		branch2.children.push(fixIt);

		const rendered = renderStripped([root], fixIt.entry.id);

		// The grandchildren carry their own connectors; the inherited gutter at
		// branch1's column must stay as space so the standard `└─` semantics
		// survive for proper tree drawings.
		for (const needle of ["grandchild c", "grandchild d"]) {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			expect(row).not.toMatch(/^\s{2}│/);
			expect(row).toMatch(/[├└]─/);
		}

		// Linear continuations of those branched grandchildren are chain rows.
		// c is not the last sibling, so its sibling line (`│` in c's connector
		// column) anchors the continuation. d is the last sibling (`└─`), so its
		// continuation is anchored one level further right instead — never in
		// d's own corner column (#2325), and never in the suppressed branch1
		// column. This is the nested case from the PR review.
		{
			const row = rendered.find(line => line.includes("c continuation"));
			if (!row) throw new Error("row containing c continuation not rendered");
			expect(row).not.toMatch(/^\s{2}│/);
			expect(row).toMatch(/^\s{5}│/);
		}
		{
			const row = rendered.find(line => line.includes("d continuation"));
			if (!row) throw new Error("row containing d continuation not rendered");
			expect(row).not.toMatch(/^\s{2}│/);
			expect(row).not.toMatch(/^\s{5}│/);
			expect(row).toMatch(/^\s{8}│/);
		}
	});
});
