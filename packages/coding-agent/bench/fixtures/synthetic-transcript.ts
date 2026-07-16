/**
 * Shared synthetic long-session fixture for Workstream A benches.
 *
 * Builds N alternating blocks (user / assistant markdown ~2KB with a code fence /
 * 2 tool executions with ~10KB results) to approximate the 155-msg/1.5MB repro
 * density (~10KB/message avg).
 *
 * Two surfaces:
 * - UI components for transcript compose / render benches
 * - AgentMessage[] for convertToLlm / estimateTokens assembly benches
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "../../src/modes/components/assistant-message";
import {
	ToolExecutionComponent,
	type ToolExecutionUi,
} from "../../src/modes/components/tool-execution";
import { UserMessageComponent } from "../../src/modes/components/user-message";

const NOOP_UI: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

const ASSISTANT_BODY = [
	"## Analysis",
	"",
	"Here is a representative assistant reply with prose and a fenced code block.",
	"The text is sized to ~2KB so long-session compose walks real Markdown L1 caches.",
	"",
	"```ts",
	"export function summarize(lines: string[]): string {",
	"  const joined = lines.join('\\n');",
	"  return joined.length > 120 ? joined.slice(0, 117) + '...' : joined;",
	"}",
	"",
	"const sample = Array.from({ length: 40 }, (_, i) => `row-${i}: value=${i * 3}`);",
	"console.log(summarize(sample));",
	"```",
	"",
	"Follow-up notes: prefer stable history walks, seal finalized blocks, and keep",
	"keystroke frames from re-composing the entire transcript tree on every char.",
	"padding ".repeat(80),
].join("\n");

const TOOL_RESULT_BODY = ("result-line: " + "x".repeat(80) + "\n").repeat(120); // ~10KB
const USER_PROMPT =
	"Please analyze the long-session transcript path and report compose cost.\n\n```ts\n// fixture user code\nconst n = 5000;\n```\n";

function makeAssistantMessage(text: string, toolCallIds?: readonly string[]): AssistantMessage {
	const content: AssistantMessage["content"] = [{ type: "text", text }];
	if (toolCallIds) {
		for (const id of toolCallIds) {
			content.push({
				type: "toolCall",
				id,
				name: "bash",
				arguments: { command: `echo ${id}` },
			});
		}
	}
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallIds && toolCallIds.length > 0 ? "toolUse" : "stop",
		timestamp: 0,
	};
}

export interface SyntheticComponents {
	/** All mounted children (finalized history + optional live lastAssistant). */
	components: Component[];
	/** Live unfinalized assistant at the end when `mutableTail` is true. */
	lastAssistant: AssistantMessageComponent | undefined;
}

/**
 * Build UI component array of roughly `n` message blocks.
 * When `mutableTail` is true, reserves the final slot for an unfinalized
 * assistant (history is N-1 finalized blocks; tail is always last).
 */
export function buildSyntheticComponents(n: number, options?: { mutableTail?: boolean }): SyntheticComponents {
	const mutableTail = options?.mutableTail === true;
	const total = Math.max(0, Math.trunc(n));
	// Reserve one slot for the live tail so it is always the last component.
	const historyCount = mutableTail ? Math.max(0, total - 1) : total;
	const components: Component[] = [];
	let remaining = historyCount;
	let seq = 0;

	while (remaining > 0) {
		// user
		if (remaining > 0) {
			components.push(new UserMessageComponent(`${USER_PROMPT}#${seq}`));
			remaining -= 1;
			seq += 1;
		}
		// finalized assistant history
		if (remaining > 0) {
			const msg = makeAssistantMessage(`${ASSISTANT_BODY}\n\nseq=${seq}`);
			const c = new AssistantMessageComponent(msg);
			if (!c.isTranscriptBlockFinalized()) c.markTranscriptBlockFinalized();
			components.push(c);
			remaining -= 1;
			seq += 1;
		}
		// two tool executions
		for (let t = 0; t < 2 && remaining > 0; t++) {
			const tool = new ToolExecutionComponent(
				"read",
				{ path: `/tmp/bench-${seq}-${t}.txt` },
				{ showImages: false },
				undefined,
				NOOP_UI,
			);
			tool.updateResult(
				{
					content: [{ type: "text", text: `${TOOL_RESULT_BODY}#${seq}-${t}` }],
					isError: false,
				},
				false,
			);
			tool.seal();
			components.push(tool);
			remaining -= 1;
			seq += 1;
		}
	}

	if (!mutableTail) {
		return { components, lastAssistant: undefined };
	}

	// Live unfinalized assistant is always the last child — no message yet
	// (compose bench mutates via updateContent outside the timed window).
	const lastAssistant = new AssistantMessageComponent();
	components.push(lastAssistant);

	const last = components[components.length - 1];
	if (last !== lastAssistant || lastAssistant.isTranscriptBlockFinalized()) {
		throw new Error(
			"synthetic-transcript: mutable lastAssistant must be last and unfinalized " +
				`(last===lastAssistant=${last === lastAssistant}, finalized=${lastAssistant.isTranscriptBlockFinalized()})`,
		);
	}

	return { components, lastAssistant };
}

/** Build AgentMessage[] with ~n entries (user / assistant / toolResult pattern). */
export function buildSyntheticAgentMessages(n: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let remaining = Math.max(0, Math.trunc(n));
	let seq = 0;

	while (remaining > 0) {
		if (remaining > 0) {
			messages.push({
				role: "user",
				content: `${USER_PROMPT}#${seq}`,
				timestamp: seq,
			});
			remaining -= 1;
			seq += 1;
		}
		if (remaining > 0) {
			const id0 = `call_${seq}_0`;
			const id1 = `call_${seq}_1`;
			// If we still have room for tool results, emit toolUse assistant; else stop.
			const emitTools = remaining > 2;
			const assistant = makeAssistantMessage(
				`${ASSISTANT_BODY}\n\nseq=${seq}`,
				emitTools ? [id0, id1] : undefined,
			);
			messages.push(assistant);
			remaining -= 1;
			seq += 1;
			if (emitTools) {
				for (let t = 0; t < 2; t++) {
					if (remaining <= 0) break;
					const id = t === 0 ? id0 : id1;
					messages.push({
						role: "toolResult",
						toolCallId: id,
						toolName: "bash",
						content: [{ type: "text", text: `${TOOL_RESULT_BODY}#${seq}-${t}` }],
						isError: false,
						timestamp: seq,
					});
					remaining -= 1;
					seq += 1;
				}
			}
		}
	}

	return messages;
}
