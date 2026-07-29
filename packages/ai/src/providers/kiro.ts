import { parseKiroCredentials } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Api, AssistantMessage, Context, Message, Model, StreamFunction, StreamOptions, TextContent } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { decodeEventStream } from "./aws-eventstream";

const KIRO_DEFAULT_REGION = "us-east-1";
const KIRO_GENERATE_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const TEXT_DECODER = new TextDecoder();

type KiroWireUserMessage = {
	userInputMessage: {
		content: string;
		origin: "KIRO_CLI";
		modelId: string;
	};
};

type KiroWireAssistantMessage = { assistantResponseMessage: { content: string } };
type KiroWireHistoryMessage = KiroWireUserMessage | KiroWireAssistantMessage;

export interface KiroOptions extends StreamOptions {
	conversationId?: string;
	profileArn?: string;
	region?: string;
}

export const streamKiro: StreamFunction<"kiro-agent"> = (
	model: Model<"kiro-agent">,
	context: Context,
	options?: KiroOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "kiro-agent",
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let textBlock: TextContent | undefined;
		try {
			const credentials = parseKiroCredentials(options?.apiKey, options?.profileArn);
			if (!credentials) throw new AIError.ConfigurationError("Kiro requires KIRO_API_KEY or an OAuth login");
			const request = buildKiroRequest(model, context, options, credentials.profileArn);
			options?.onPayload?.(request, model);
			const region = options?.region ?? KIRO_DEFAULT_REGION;
			const baseUrl = model.baseUrl ?? `https://runtime.${region}.kiro.dev`;
			const response = await (options?.fetch ?? fetch)(baseUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.accessToken}`,
					accept: "application/vnd.amazon.eventstream",
					"content-type": "application/x-amz-json-1.0",
					"x-amz-target": KIRO_GENERATE_TARGET,
					...(options?.headers ?? {}),
				},
				body: JSON.stringify(request),
				signal: options?.signal,
			});
			if (!response.ok) {
				throw new AIError.ProviderHttpError(
					`Kiro API error ${response.status}: ${(await response.text()).slice(0, 1_000)}`,
					response.status,
					{ headers: response.headers },
				);
			}
			if (!response.body) {
				throw new AIError.ProviderResponseError("Kiro response body is empty", { provider: model.provider });
			}

			stream.push({ type: "start", partial: output });
			for await (const frame of decodeEventStream(response.body)) {
				const messageType = frame.headers[":message-type"];
				if (messageType === "exception" || messageType === "error") {
					throw new AIError.ProviderHttpError(
						`Kiro stream error: ${TEXT_DECODER.decode(frame.payload)}`,
						400,
						{ code: frame.headers[":exception-type"] ?? frame.headers[":error-code"] },
					);
				}
				if (messageType !== "event") continue;
				const payload = parseEventPayload(frame.payload);
				if (!payload) continue;
				switch (frame.headers[":event-type"]) {
					case "assistantResponseEvent": {
						if (typeof payload.content !== "string" || payload.content.length === 0) break;
						if (!textBlock) {
							textBlock = { type: "text", text: "" };
							output.content.push(textBlock);
							stream.push({
								type: "text_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						if (firstTokenTime === undefined) firstTokenTime = performance.now();
						textBlock.text += payload.content;
						stream.push({
							type: "text_delta",
							contentIndex: output.content.indexOf(textBlock),
							delta: payload.content,
							partial: output,
						});
						break;
					}
					case "metadataEvent":
						output.stopReason = payload.stopReason === "END_TURN" ? "stop" : "error";
						break;
					default:
						break;
				}
			}
			if (options?.signal?.aborted) throw new AIError.AbortError();
			if (textBlock) {
				stream.push({
					type: "text_end",
					contentIndex: output.content.indexOf(textBlock),
					content: textBlock.text,
					partial: output,
				});
			}
			if (output.stopReason === "error") {
				throw new AIError.ProviderResponseError("Kiro ended the response without END_TURN", {
					provider: model.provider,
				});
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			calculateCost(model, output.usage);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};

function buildKiroRequest(
	model: Model<"kiro-agent">,
	context: Context,
	options: KiroOptions | undefined,
	profileArn?: string,
) {
	const history = context.messages.flatMap(message => toKiroHistoryMessage(message, model.id));
	const latestUserIndex = findLastUserMessage(history);
	if (latestUserIndex < 0) throw new AIError.ConfigurationError("Kiro requires a user message");
	const currentMessage = history[latestUserIndex];
	if (!("userInputMessage" in currentMessage)) throw new AIError.ConfigurationError("Kiro requires a user message");
	const systemPrompt = context.systemPrompt?.filter(Boolean).join("\n\n");
	if (systemPrompt) currentMessage.userInputMessage.content = `${systemPrompt}\n\n${currentMessage.userInputMessage.content}`;
	return {
		conversationState: {
			conversationId: options?.conversationId ?? "",
			history: history.slice(0, latestUserIndex),
			currentMessage,
			chatTriggerType: "MANUAL",
			agentContinuationId: "",
			agentTaskType: "",
		},
		...(profileArn ? { profileArn } : {}),
	};
}

function findLastUserMessage(messages: readonly KiroWireHistoryMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if ("userInputMessage" in messages[index]) return index;
	}
	return -1;
}

function toKiroHistoryMessage(message: Message, modelId: string): KiroWireHistoryMessage[] {
	if (message.role === "assistant") {
		const content = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		return content ? [{ assistantResponseMessage: { content } }] : [];
	}
	const content =
		message.role === "toolResult"
			? message.content.map(block => (block.type === "text" ? block.text : `[${block.mimeType} image]`)).join("\n")
			: userContent(message.content);
	return content ? [{ userInputMessage: { content, origin: "KIRO_CLI", modelId } }] : [];
}

function userContent(
	content: string | readonly ({ type: "text"; text: string } | { type: "image"; mimeType: string })[],
): string {
	if (typeof content === "string") return content;
	return content.map(block => (block.type === "text" ? block.text : `[${block.mimeType} image]`)).join("\n");
}

function parseEventPayload(payload: Uint8Array): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(TEXT_DECODER.decode(payload));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
