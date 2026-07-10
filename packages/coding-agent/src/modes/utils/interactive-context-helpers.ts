/**
 * Small helpers over {@link InteractiveModeContext} shared between
 * {@link UiHelpers} and the input/event controllers, so the live chat surfaces
 * construct components and reset editor state identically.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../components/assistant-message";
import type { InteractiveModeContext } from "../types";

export type AssistantMessageContext = Pick<
	InteractiveModeContext,
	"effectiveHideThinkingBlock" | "proseOnlyThinking"
> & {
	settings: Pick<InteractiveModeContext["settings"], "get">;
	ui: Pick<InteractiveModeContext["ui"], "imageBudget" | "requestRender">;
	viewSession: {
		extensionRunner: InteractiveModeContext["viewSession"]["extensionRunner"];
	};
};

/**
 * Construct an {@link AssistantMessageComponent} wired to the live context's
 * thinking/image settings. `message` is omitted for the streaming placeholder
 * component and supplied when rendering a persisted turn.
 */
export function createAssistantMessageComponent(
	ctx: AssistantMessageContext,
	message?: AssistantMessage,
): AssistantMessageComponent {
	return new AssistantMessageComponent(
		message,
		ctx.effectiveHideThinkingBlock,
		() => ctx.ui.requestRender(),
		ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
		ctx.ui.imageBudget,
		ctx.proseOnlyThinking,
		() => ctx.settings.get("terminal.showImages") !== false,
	);
}
