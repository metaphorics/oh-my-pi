import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CompactionCancelledError, type CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, Spacer } from "@oh-my-pi/pi-tui";

/**
 * Contract under test: `CommandController.executeCompaction` must not leak
 * transient UI across either terminal state.
 *
 *  - A cancelled compaction (session.compact rejects with the real
 *    CompactionCancelledError the code branches on) must leave the chat
 *    transcript byte-for-byte as it was — no orphan Spacer pushed into
 *    chatContainer — and must drain the status container's loader.
 *  - A successful compaction must drain the status container's loader once it
 *    resolves.
 *
 * Exercised only through the public `executeCompaction` entrypoint with real
 * in-memory Container instances and a session stub whose `compact()` outcome we
 * drive.
 */
function buildCtx(compact: InteractiveModeContext["session"]["compact"]) {
	const chatContainer = new Container();
	const statusContainer = new Container();
	// Pre-existing transcript content. The regression we defend leaked an extra
	// Spacer into this container on the cancel path, so we seed it with real
	// children and require the count to survive the call untouched.
	chatContainer.addChild(new Spacer(1));
	chatContainer.addChild(new Spacer(1));

	const rebuildChatFromMessages = vi.fn();
	const showError = vi.fn();
	const ctx = {
		loadingAnimation: undefined,
		chatContainer,
		statusContainer,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		session: { compact },
		rebuildChatFromMessages,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		showError,
		flushCompactionQueue: vi.fn(async () => undefined),
	} as unknown as InteractiveModeContext;

	return { ctx, chatContainer, statusContainer, rebuildChatFromMessages, showError };
}

describe("executeCompaction UI lifecycle", () => {
	beforeAll(async () => {
		// The compacting Loader colorizes through the active theme on construction.
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves the transcript untouched and drains the loader when compaction is cancelled", async () => {
		const compact = vi.fn(async () => {
			throw new CompactionCancelledError();
		});
		const { ctx, chatContainer, statusContainer, rebuildChatFromMessages, showError } = buildCtx(compact);
		const childrenBefore = chatContainer.children.length;

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("cancelled");
		// No orphan Spacer leaked into the chat transcript on the cancel path.
		expect(chatContainer.children).toHaveLength(childrenBefore);
		// The compacting loader was removed from the status container.
		expect(statusContainer.children).toHaveLength(0);
		// Proof the cancel branch ran instead of the success branch.
		expect(showError).toHaveBeenCalledWith("Compaction cancelled");
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	it("drains the loader after a successful compaction resolves", async () => {
		const compact = vi.fn(
			async (): Promise<CompactionResult<unknown>> => ({ summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
		);
		const { ctx, statusContainer, rebuildChatFromMessages } = buildCtx(compact);

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		// Status container is empty once compaction resolves.
		expect(statusContainer.children).toHaveLength(0);
		// Proof the success branch ran (rebuild happens only on the ok path).
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
	});
});
