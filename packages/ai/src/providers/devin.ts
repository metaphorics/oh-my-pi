import type { ClientHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	PromptCacheOptionsSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/chat_pb/chat_pb";
import {
	ChatMessageSource,
	type ChatToolCall,
	ChatToolCallSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	ImageDataSchema,
	MetadataSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger, parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import {
	acquireH2Session,
	CONNECT_COMPRESSED_FLAG,
	type ConnectFrame,
	createConnectFrameReader,
	encodeConnectFrame,
	type H2Lease,
	isTransientTransportError,
	readConnectTrailerError,
	registerTransportDisposer,
} from "../transport";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { isDemotedThinking } from "../utils/block-symbols";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";
import { transformMessages } from "./transform-messages";

/** Base host for the current Devin CLI's Codeium Connect RPCs. */
export const DEVIN_API_URL = "https://server.codeium.com";

export interface DevinOptions extends StreamOptions {
	/** Cascade conversation id; reused as `cascade_id` so the server threads turns. */
	conversationId?: string;
	/** Falls back to `cascade_id` when no `conversationId` is supplied. */
	sessionId?: string;
	/** Wire model uid selected after thinking-effort routing. */
	chatModelUid?: string;
}

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_IDE_VERSION = "0.0.0-dev";
const DEVIN_EXTENSION_VERSION = "0.0.0-dev";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
const DEVIN_DEFAULT_STOP_PATTERNS = [
	"<|user|>",
	"<|bot|>",
	"<|context_request|>",
	"<\u007cendoftext\u007c>",
	"<|end_of_turn|>",
];

/**
 * Recovery heuristic for opaque Devin `invalid_argument` trailers. This is not
 * asserted to be the backend's hard limit: small requests can hit the same
 * intermittent error, while compactable message history this large is likely
 * to benefit from the existing context-overflow maintenance path.
 */
const LARGE_HISTORY_RECOVERY_BYTES = 512 * 1024;

interface ActiveDevinTransport {
	abort: AbortController;
	settled: Promise<void>;
}

const activeDevinTransports = new Set<ActiveDevinTransport>();

async function disposeDevinTransports(): Promise<void> {
	const active = [...activeDevinTransports];
	for (const transport of active) transport.abort.abort(new Error("Devin transport disposed"));
	await Promise.allSettled(active.map(transport => transport.settled));
}

registerTransportDisposer("devin", disposeDevinTransports);

export const streamDevin: StreamFunction<"devin-agent"> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: DevinOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const transportAbort = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, transportAbort.signal]) : transportAbort.signal;
	const { promise: transportSettled, resolve: resolveTransportSettled } = Promise.withResolvers<void>();
	const activeTransport = { abort: transportAbort, settled: transportSettled };
	activeDevinTransports.add(activeTransport);

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "devin-agent" as Api,
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

		let currentTextBlock: TextContent | null = null;
		let currentThinkingBlock: ThinkingContent | null = null;
		// Tool-call content blocks keyed by streamed tool-call id, plus the JSON-args text
		// accumulated per id (kept out of the content object so finalized tool calls stay clean).
		const toolBlocks = new Map<string, ToolCall>();
		const toolPartialJson = new Map<string, string>();
		// Last-parsed argument-buffer length per tool-call id — bounds the
		// mid-stream parse work to O(N) via `parseStreamingJsonThrottled`; the
		// authoritative final parse still runs unconditionally in the toolcall_end
		// loop below.
		const toolLastParseLen = new Map<string, number>();
		let activeToolCallId: string | undefined;
		let latestStopReason = StopReason.UNSPECIFIED;
		let h2Lease: H2Lease | undefined;
		let h2Request: ClientHttp2Stream | undefined;

		const markFirstToken = () => {
			if (firstTokenTime === undefined) firstTokenTime = performance.now();
		};

		const endTextBlock = () => {
			const block = currentTextBlock;
			if (!block) return;
			currentTextBlock = null;
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(block),
				content: block.text,
				partial: output,
			});
		};

		const endThinkingBlock = () => {
			const block = currentThinkingBlock;
			if (!block) return;
			currentThinkingBlock = null;
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(block),
				content: block.thinking,
				partial: output,
			});
		};

		try {
			const fetchImpl = options?.fetch ?? fetch;
			const baseUrl = (model.baseUrl || DEVIN_API_URL).replace(/\/+$/, "");
			const apiKey = normalizeDevinSessionToken(options?.apiKey);
			const request = buildDevinChatRequest(model, context, options, apiKey);
			const reqBytes = toBinary(GetChatMessageRequestSchema, request);
			const gz = gzipSync(reqBytes);
			logger.debug("devin: sending chat request", {
				model: model.id,
				tools: context.tools?.length ?? 0,
				requestBytes: reqBytes.byteLength,
				compressedBytes: gz.byteLength,
			});
			const frame = encodeConnectFrame(gz, CONNECT_COMPRESSED_FLAG);
			const commonHeaders = {
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
				"connect-content-encoding": "gzip",
				"accept-encoding": "identity",
				authorization: `Basic ${apiKey}`,
				"connect-accept-encoding": "gzip",
				...(options?.headers ?? {}),
			};

			let body: AsyncIterable<Uint8Array>;
			if (options?.fetch) {
				body = await fetchDevinChatBody({
					url: baseUrl + CHAT_MESSAGE_PATH,
					headers: commonHeaders,
					frame,
					fetchImpl,
					signal,
					provider: model.provider,
				});
			} else {
				try {
					h2Lease = await acquireH2Session(baseUrl, model.provider, signal);
					h2Request = await h2Lease.request(
						{
							":method": "POST",
							":path": CHAT_MESSAGE_PATH,
							...commonHeaders,
							te: "trailers",
						},
						{ signal },
					);
					const responseHeaders = Promise.withResolvers<IncomingHttpHeaders>();
					h2Request.once("response", headers => responseHeaders.resolve(headers));
					h2Request.once("error", error => responseHeaders.reject(error));
					h2Request.once("close", () => {
						responseHeaders.reject(
							new AIError.ProviderResponseError("Devin HTTP/2 stream closed before response headers", {
								provider: model.provider,
								kind: "incomplete-stream",
							}),
						);
					});
					h2Request.end(frame);
					const headers = await responseHeaders.promise;
					const status = Number(headers[":status"] ?? 0);
					if (status < 200 || status >= 300) {
						const chunks: Uint8Array[] = [];
						for await (const chunk of h2Request) chunks.push(chunk);
						const text = new TextDecoder().decode(Buffer.concat(chunks));
						throw new AIError.DevinApiError(`Devin API error ${status}: ${text}`, status);
					}
					body = h2Request;
				} catch (error) {
					h2Request?.close();
					h2Request = undefined;
					h2Lease?.release();
					h2Lease = undefined;
					if (error instanceof AIError.DevinApiError || !isTransientTransportError(error)) throw error;
					logger.warn("devin: HTTP/2 unavailable, falling back to HTTP/1", { error: String(error) });
					body = await fetchDevinChatBody({
						url: baseUrl + CHAT_MESSAGE_PATH,
						headers: commonHeaders,
						frame,
						fetchImpl,
						signal,
						provider: model.provider,
					});
				}
			}

			stream.push({ type: "start", partial: output });
			const frameReader = createConnectFrameReader();
			for await (const chunk of body) {
				let frames: ConnectFrame[];
				try {
					frames = frameReader.push(chunk);
				} catch (error) {
					throw new AIError.ProviderResponseError(
						`Devin ${error instanceof Error ? error.message : String(error)}`,
						{ provider: model.provider, kind: "envelope" },
					);
				}
				for (const connectFrame of frames) {
					if (connectFrame.endOfStream) {
						const trailerError = readConnectTrailerError(connectFrame.payload);
						if (trailerError) {
							const formatted = `Devin stream error${trailerError.code ? ` ${trailerError.code}` : ""}: ${trailerError.message}`;
							const error = new AIError.ValidationError(formatted);
							if (
								firstTokenTime === undefined &&
								trailerError.code.toLowerCase() === "invalid_argument" &&
								/\binternal error\b/i.test(trailerError.message)
							) {
								// The full protobuf also contains the system prompt and tool
								// schemas, which history maintenance cannot shrink. Re-encode
								// only the repeated history field before choosing recovery.
								let activeTailCount = 0;
								const lastRole = context.messages.at(-1)?.role;
								if (lastRole === "user" || lastRole === "developer") {
									activeTailCount = 1;
									// A trailing developer message can accompany the current user
									// prompt. Earlier user-role records may instead be flushed
									// execution history and must remain eligible for compaction.
									if (lastRole === "developer") {
										for (let i = context.messages.length - 2; i >= 0; i--) {
											const role = context.messages[i].role;
											if (role !== "user" && role !== "developer") break;
											activeTailCount++;
										}
									}
								}
								const shrinkablePrompts =
									activeTailCount > 0
										? request.chatMessagePrompts.slice(0, -activeTailCount)
										: request.chatMessagePrompts;
								const historyBytes = toBinary(
									GetChatMessageRequestSchema,
									create(GetChatMessageRequestSchema, {
										chatMessagePrompts: shrinkablePrompts,
									}),
								).byteLength;
								if (historyBytes >= LARGE_HISTORY_RECOVERY_BYTES) {
									AIError.attach(error, AIError.create(AIError.Flag.ContextOverflow));
									logger.warn("devin: treating large-history invalid_argument as context overflow", {
										model: model.id,
										historyBytes,
										requestBytes: reqBytes.byteLength,
										compressedBytes: gz.byteLength,
									});
								}
							}
							throw error;
						}
						continue;
					}

					const msg = fromBinary(GetChatMessageResponseSchema, connectFrame.payload);
					if (msg.messageId && !output.responseId) output.responseId = msg.messageId;

					if (msg.deltaThinking) {
						markFirstToken();
						const block: ThinkingContent = currentThinkingBlock ?? { type: "thinking", thinking: "" };
						if (currentThinkingBlock !== block) {
							output.content.push(block);
							currentThinkingBlock = block;
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						block.thinking += msg.deltaThinking;
						if (msg.deltaSignature) block.thinkingSignature = msg.deltaSignature;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaThinking,
							partial: output,
						});
					}

					if (msg.deltaText) {
						markFirstToken();
						endThinkingBlock();
						const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
						if (currentTextBlock !== block) {
							output.content.push(block);
							currentTextBlock = block;
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						}
						block.text += msg.deltaText;
						stream.push({
							type: "text_delta",
							contentIndex: output.content.indexOf(block),
							delta: msg.deltaText,
							partial: output,
						});
					}

					if (msg.deltaToolCalls.length > 0) {
						markFirstToken();
						endTextBlock();
						endThinkingBlock();
						for (const tc of msg.deltaToolCalls) {
							const toolCallId = tc.id || activeToolCallId;
							if (!toolCallId) continue;
							let block = toolBlocks.get(toolCallId);
							if (!block) {
								block = { type: "toolCall", id: toolCallId, name: tc.name, arguments: {} };
								output.content.push(block);
								toolBlocks.set(toolCallId, block);
								toolPartialJson.set(toolCallId, "");
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
							if (tc.name) block.name = tc.name;
							activeToolCallId = toolCallId;
							if (!tc.argumentsJson) continue;
							const previousJson = toolPartialJson.get(toolCallId) ?? "";
							const accumulated = tc.argumentsJson.startsWith(previousJson)
								? tc.argumentsJson
								: previousJson + tc.argumentsJson;
							const delta = accumulated.slice(previousJson.length);
							toolPartialJson.set(toolCallId, accumulated);
							const throttled = parseStreamingJsonThrottled(accumulated, toolLastParseLen.get(toolCallId) ?? 0);
							if (throttled) {
								block.arguments = throttled.value;
								toolLastParseLen.set(toolCallId, throttled.parsedLen);
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: output.content.indexOf(block),
								delta,
								partial: output,
							});
						}
					}

					if (msg.stopReason !== StopReason.UNSPECIFIED) {
						latestStopReason = msg.stopReason;
					}

					if (msg.usage) {
						output.usage.input = Number(msg.usage.inputTokens);
						output.usage.output = Number(msg.usage.outputTokens);
						output.usage.cacheRead = Number(msg.usage.cacheReadTokens);
						output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens);
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					}
				}
			}

			if (h2Request && !h2Request.readableEnded) {
				throw new AIError.ProviderResponseError("Devin HTTP/2 stream closed before the response ended", {
					provider: model.provider,
					kind: "incomplete-stream",
				});
			}

			endTextBlock();
			endThinkingBlock();
			for (const [id, block] of toolBlocks) {
				block.arguments = parseStreamingJson(toolPartialJson.get(id));
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(block),
					toolCall: block,
					partial: output,
				});
			}

			const doneReason: "stop" | "length" | "toolUse" =
				toolBlocks.size > 0 ? "toolUse" : latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop";
			output.stopReason = doneReason;

			calculateCost(model, output.usage);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;

			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			logger.error("devin: stream failed", { error: String(error) });
			const classifiedError = isTransientTransportError(error)
				? AIError.attach(
						error instanceof Error ? error : new Error(String(error)),
						AIError.create(AIError.Flag.Transient),
					)
				: error;
			const result = await AIError.finalize(classifiedError, { api: model.api, signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: result.stopReason, error: output });
			stream.end();
		} finally {
			h2Request?.close();
			h2Request = undefined;
			h2Lease?.release();
			h2Lease = undefined;
			activeDevinTransports.delete(activeTransport);
			resolveTransportSettled();
		}
	})();

	return stream;
};

function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

async function fetchDevinChatBody(options: {
	url: string;
	headers: Record<string, string>;
	frame: Uint8Array;
	fetchImpl: NonNullable<StreamOptions["fetch"]>;
	signal: AbortSignal;
	provider: string;
}): Promise<ReadableStream<Uint8Array>> {
	const response = await options.fetchImpl(options.url, {
		method: "POST",
		headers: options.headers,
		body: options.frame,
		signal: options.signal,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new AIError.DevinApiError(
			`Devin API error ${response.status} ${response.statusText}: ${text}`,
			response.status,
		);
	}
	if (!response.body) {
		throw new AIError.ProviderResponseError("Devin API error: response body is empty", {
			provider: options.provider,
			kind: "empty-body",
		});
	}
	return response.body;
}

/**
 * Build a {@link GetChatMessageRequest} for one Cascade turn. Auth rides inside
 * `Metadata.apiKey`; the system prompt is the flattened `prompt` string and the
 * conversation history maps to `chatMessagePrompts`.
 */
function buildDevinChatRequest(
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
	apiKey: string,
) {
	const cascadeId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
	const stopPatterns =
		options?.stopSequences && options.stopSequences.length > 0
			? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
			: DEVIN_DEFAULT_STOP_PATTERNS;
	const messages = transformMessages(context.messages, model);
	return create(GetChatMessageRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			ideName: "chisel",
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: "chisel",
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
			os: process.platform,
		}),
		prompt: (context.systemPrompt ?? []).join("\n\n"),
		chatMessagePrompts: buildChatMessagePrompts(messages, cascadeId, model),
		chatModelUid: options?.chatModelUid ?? model.requestModelId ?? model.id,
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		disableParallelToolCalls: true,
		cascadeId,
		executionId: crypto.randomUUID(),
		configuration: create(CompletionConfigurationSchema, {
			numCompletions: 1n,
			maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
			maxNewlines: 200n,
			temperature: options?.temperature ?? 0.4,
			firstTemperature: options?.temperature ?? 0.4,
			topK: 50n,
			topP: options?.topP ?? 1,
			stopPatterns,
			fimEotProbThreshold: 1,
		}),
		tools: (context.tools ?? []).map((tool: Tool) =>
			create(ChatToolDefinitionSchema, {
				name: tool.name,
				description: tool.description,
				jsonSchemaString: JSON.stringify(toolWireSchema(tool)),
				strict: tool.strict ?? false,
			}),
		),
	});
}

/** Map omp `Message` history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM / TOOL channels). */
function buildChatMessagePrompts(
	messages: Message[],
	cascadeId: string,
	model: Model<"devin-agent">,
): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	// messageId seeds are `cascadeId\0index\0role[...]` — prompt text is excluded
	// so ids stay stable across content edits / history rebuilds.
	for (const [index, msg] of messages.entries()) {
		if (msg.role === "user" || msg.role === "developer") {
			let promptText = "";
			const images = [];
			if (typeof msg.content === "string") {
				promptText = msg.content;
			} else {
				for (const part of msg.content) {
					if (part.type === "text") {
						promptText += part.text;
					} else if (part.type === "image") {
						images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
					}
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`),
					source: ChatMessageSource.USER,
					prompt: promptText,
					images,
				}),
			);
		} else if (msg.role === "assistant") {
			const isNativeDevinMessage =
				msg.api === model.api && msg.provider === model.provider && msg.model === model.id;
			let promptText = "";
			let thinkingText = "";
			let signature = "";
			const toolCalls: ChatToolCall[] = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					promptText += `${part.text}${isDemotedThinking(part) ? "\n" : ""}`;
				} else if (part.type === "thinking") {
					thinkingText += part.thinking;
					if (isNativeDevinMessage && !signature && part.thinkingSignature) signature = part.thinkingSignature;
				} else if (part.type === "toolCall") {
					toolCalls.push(
						create(ChatToolCallSchema, {
							id: part.id,
							name: part.name,
							argumentsJson: JSON.stringify(part.arguments),
						}),
					);
				}
			}
			if (!promptText && !thinkingText && !signature && toolCalls.length === 0) continue;
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId:
						isNativeDevinMessage && msg.responseId
							? msg.responseId
							: `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
					source: ChatMessageSource.SYSTEM,
					prompt: promptText,
					thinking: thinkingText,
					signature,
					signatureType: "",
					toolCalls,
				}),
			);
		} else {
			let resultText = "";
			const images = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					resultText += part.text;
				} else if (part.type === "image") {
					images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId}`),
					source: ChatMessageSource.TOOL,
					toolCallId: msg.toolCallId,
					toolResultIsError: msg.isError,
					prompt: resultText,
					images,
				}),
			);
		}
	}
	return prompts;
}
