import type * as http2 from "node:http2";
import * as nodeStream from "node:stream";
import { parseKiroCredentials } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isRecord, parseStreamingJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { acquireH2Session, type H2Lease, isTransientTransportError } from "../transport";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";
import { decodeEventStream } from "./aws-eventstream";

const KIRO_DEFAULT_REGION = "us-east-1";
const KIRO_GENERATE_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const TEXT_DECODER = new TextDecoder();

type KiroWireToolSpecification = {
	toolSpecification: {
		name: string;
		description: string;
		inputSchema: { json: Record<string, unknown> };
	};
};

type KiroWireToolResult = {
	toolUseId: string;
	status: "success" | "error";
	content: Array<{ text: string }>;
};

type KiroWireUserMessage = {
	userInputMessage: {
		content: string;
		userInputMessageContext?: {
			envState?: { operatingSystem: string; currentWorkingDirectory: string };
			tools?: KiroWireToolSpecification[];
			toolResults?: KiroWireToolResult[];
		};
		origin: "KIRO_CLI";
		modelId: string;
	};
};

type KiroWireAssistantMessage = {
	assistantResponseMessage: {
		content: string;
		toolUses?: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }>;
	};
};
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
			stopReason: "error",
			timestamp: Date.now(),
		};
		let textBlock: TextContent | undefined;
		let thinkingBlock: ThinkingContent | undefined;
		const toolBlocks = new Map<string, ToolCall>();
		const toolPartialJson = new Map<string, string>();
		let sawEndTurn = false;
		let h2Lease: H2Lease | undefined;
		let h2Request: http2.ClientHttp2Stream | undefined;
		let completed = false;
		try {
			const credentials = parseKiroCredentials(options?.apiKey, options?.profileArn);
			if (!credentials) throw new AIError.ConfigurationError("Kiro requires KIRO_API_KEY or an OAuth login");
			const request = buildKiroRequest(model, context, options, credentials.profileArn);
			options?.onPayload?.(request, model);
			const region = options?.region ?? KIRO_DEFAULT_REGION;
			const requestUrl = new URL(model.baseUrl ?? `https://runtime.${region}.kiro.dev`);
			const responseHeaders = Promise.withResolvers<http2.IncomingHttpHeaders>();
			let sawResponse = false;
			h2Lease = await acquireH2Session(requestUrl.origin, model.provider, options?.signal);
			h2Request = await h2Lease.request(
				{
					":method": "POST",
					":path": `${requestUrl.pathname}${requestUrl.search}`,
					authorization: `Bearer ${credentials.accessToken}`,
					accept: "application/vnd.amazon.eventstream",
					"content-type": "application/x-amz-json-1.0",
					"x-amz-target": KIRO_GENERATE_TARGET,
					...(options?.headers ?? {}),
				},
				{ signal: options?.signal },
			);
			h2Request.once("response", headers => {
				sawResponse = true;
				responseHeaders.resolve(headers);
			});
			h2Request.once("error", error => responseHeaders.reject(error));
			h2Request.once("close", () => {
				if (!sawResponse) {
					responseHeaders.reject(
						new AIError.ProviderResponseError("Kiro HTTP/2 stream closed before response headers", {
							provider: model.provider,
							kind: "incomplete-stream",
						}),
					);
				}
			});
			h2Request.end(JSON.stringify(request));

			const headers = await responseHeaders.promise;
			const status = Number(headers[":status"] ?? 0);
			if (status < 200 || status >= 300) {
				const chunks: Uint8Array[] = [];
				for await (const chunk of h2Request) {
					chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
				}
				const body = Buffer.concat(chunks).toString("utf8").slice(0, 1_000);
				throw new AIError.ProviderHttpError(`Kiro API error ${status}: ${body}`, status);
			}

			stream.push({ type: "start", partial: output });
			const body = nodeStream.Readable.toWeb(h2Request) as ReadableStream<Uint8Array>;
			for await (const frame of decodeEventStream(body)) {
				const messageType = frame.headers[":message-type"];
				if (messageType === "exception" || messageType === "error") {
					const code = frame.headers[":exception-type"] ?? frame.headers[":error-code"];
					throw new AIError.ProviderHttpError(
						`Kiro stream error: ${TEXT_DECODER.decode(frame.payload)}`,
						kiroStreamErrorStatus(code),
						{
							code,
						},
					);
				}
				if (messageType !== "event") continue;
				const payload = parseEventPayload(frame.payload);
				if (!payload) continue;
				switch (frame.headers[":event-type"]) {
					case "reasoningContentEvent": {
						if (typeof payload.text !== "string" || payload.text.length === 0) break;
						if (!thinkingBlock) {
							thinkingBlock = { type: "thinking", thinking: "" };
							output.content.push(thinkingBlock);
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						if (firstTokenTime === undefined) firstTokenTime = performance.now();
						thinkingBlock.thinking += payload.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(thinkingBlock),
							delta: payload.text,
							partial: output,
						});
						break;
					}
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
					case "toolUseEvent": {
						const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : "";
						if (!toolUseId) break;
						let block = toolBlocks.get(toolUseId);
						if (!block) {
							block = {
								type: "toolCall",
								id: toolUseId,
								name: typeof payload.name === "string" ? payload.name : "",
								arguments: {},
							};
							toolBlocks.set(toolUseId, block);
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						}
						if (typeof payload.name === "string" && payload.name) block.name = payload.name;
						const delta =
							typeof payload.input === "string"
								? payload.input
								: payload.input === undefined
									? ""
									: JSON.stringify(payload.input);
						if (delta) {
							const accumulated = `${toolPartialJson.get(toolUseId) ?? ""}${delta}`;
							toolPartialJson.set(toolUseId, accumulated);
							block.arguments = parseStreamingJson(accumulated);
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							});
						}
						break;
					}
					case "metadataEvent":
						if (payload.stopReason === "END_TURN") sawEndTurn = true;
						break;
					default:
						break;
				}
			}
			if (options?.signal?.aborted) throw new AIError.AbortError();
			if (thinkingBlock) {
				stream.push({
					type: "thinking_end",
					contentIndex: output.content.indexOf(thinkingBlock),
					content: thinkingBlock.thinking,
					partial: output,
				});
			}
			if (textBlock) {
				stream.push({
					type: "text_end",
					contentIndex: output.content.indexOf(textBlock),
					content: textBlock.text,
					partial: output,
				});
			}
			for (const [id, block] of toolBlocks) {
				block.arguments = parseStreamingJson(toolPartialJson.get(id));
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(block),
					toolCall: block,
					partial: output,
				});
			}
			if (!sawEndTurn) {
				throw new AIError.ProviderResponseError("Kiro ended the response without END_TURN", {
					provider: model.provider,
					kind: "incomplete-stream",
				});
			}
			output.stopReason = toolBlocks.size > 0 ? "toolUse" : "stop";
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			calculateCost(model, output.usage);
			completed = true;
			const doneReason =
				output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop";
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			if (!completed) h2Request?.close();
			const classifiedError = isTransientTransportError(error)
				? AIError.attach(
						error instanceof Error ? error : new Error(String(error)),
						AIError.create(AIError.Flag.Transient),
					)
				: error;
			const result = await AIError.finalize(classifiedError, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			h2Lease?.release();
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
	const wireModelId = model.requestModelId ?? model.id;
	const latestInputIndex = findLastInputMessage(context.messages);
	if (latestInputIndex < 0) throw new AIError.ConfigurationError("Kiro requires a user message or tool result");
	const currentInputIndex =
		context.messages[latestInputIndex]?.role === "toolResult"
			? findTrailingToolResultStart(context.messages, latestInputIndex)
			: latestInputIndex;
	const history = context.messages
		.slice(0, currentInputIndex)
		.flatMap(message => toKiroHistoryMessage(message, wireModelId));
	const latestMessage = context.messages[currentInputIndex];
	if (latestMessage.role !== "user" && latestMessage.role !== "developer" && latestMessage.role !== "toolResult") {
		throw new AIError.ConfigurationError("Kiro requires a user message or tool result");
	}
	const currentMessage: KiroWireUserMessage = {
		userInputMessage: {
			content: latestMessage.role === "toolResult" ? "Tool results provided." : userContent(latestMessage.content),
			origin: "KIRO_CLI",
			modelId: wireModelId,
		},
	};
	const systemPrompt = context.systemPrompt?.filter(Boolean).join("\n\n");
	if (systemPrompt)
		currentMessage.userInputMessage.content = `${systemPrompt}\n\n${currentMessage.userInputMessage.content}`;
	const toolResults = context.messages
		.slice(currentInputIndex)
		.filter((message): message is ToolResultMessage => message.role === "toolResult")
		.map(toKiroToolResult);
	const tools: KiroWireToolSpecification[] =
		context.tools?.map(tool => ({
			toolSpecification: {
				name: tool.name,
				description: tool.description,
				inputSchema: { json: toolWireSchema(tool) },
			},
		})) ?? [];
	currentMessage.userInputMessage.userInputMessageContext = {
		envState: { operatingSystem: process.platform, currentWorkingDirectory: options?.cwd ?? process.cwd() },
		...(tools.length > 0 ? { tools } : undefined),
		...(toolResults.length > 0 ? { toolResults } : undefined),
	};
	return {
		conversationState: {
			conversationId: options?.conversationId ?? options?.sessionId ?? crypto.randomUUID(),
			history,
			currentMessage,
			chatTriggerType: "MANUAL",
			agentContinuationId: crypto.randomUUID(),
			agentTaskType: "vibe",
		},
		...(profileArn ? { profileArn } : {}),
	};
}

function findLastInputMessage(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const role = messages[index]?.role;
		if (role === "user" || role === "developer" || role === "toolResult") return index;
	}
	return -1;
}
function findTrailingToolResultStart(messages: readonly Message[], lastIndex: number): number {
	let index = lastIndex;
	while (index > 0 && messages[index - 1]?.role === "toolResult") index -= 1;
	return index;
}

function toKiroToolResult(message: ToolResultMessage): KiroWireToolResult {
	return {
		toolUseId: message.toolCallId,
		status: message.isError ? "error" : "success",
		content: [{ text: userContent(message.content) }],
	};
}

function toKiroHistoryMessage(message: Message, modelId: string): KiroWireHistoryMessage[] {
	if (message.role === "assistant") {
		const content = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const toolUses = message.content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.map(block => ({ toolUseId: block.id, name: block.name, input: block.arguments }));
		return content || toolUses.length > 0
			? [{ assistantResponseMessage: { content, ...(toolUses.length > 0 ? { toolUses } : undefined) } }]
			: [];
	}
	if (message.role === "toolResult") return [];
	const content = userContent(message.content);
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

function kiroStreamErrorStatus(code: string | undefined): number {
	switch (code?.toLowerCase()) {
		case "internalserverexception":
		case "serviceunavailableexception":
			return 503;
		case "throttlingexception":
			return 429;
		default:
			return 400;
	}
}
