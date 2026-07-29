import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { gzipSync } from "node:zlib";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
	acquireH2Session,
	CONNECT_COMPRESSED_FLAG,
	CONNECT_END_STREAM_FLAG,
	createConnectFrameReader,
	createHttp1Bridge,
	disposeH2Pool,
	disposeHttp1Bridges,
	encodeConnectFrame,
	isTransientTransportError,
	normalizeConnectAuthError,
	readConnectTrailerError,
} from "@oh-my-pi/pi-ai";
import { CursorCredentialError } from "../src/error";

const servers = new Set<http2.Http2Server>();

afterEach(async () => {
	await disposeHttp1Bridges();
	await disposeH2Pool();
	await Promise.all(
		[...servers].map(server => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		}),
	);
	servers.clear();
});

function abortPromise(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	const aborted = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
	return aborted.promise;
}

async function listen(
	onStream: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
): Promise<{ baseUrl: string; server: http2.Http2Server }> {
	const server = http2.createServer();
	servers.add(server);
	server.on("stream", onStream);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => resolve());
	await promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP/2 test server has no TCP address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function readAll(stream: http2.ClientHttp2Stream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

describe("shared Connect framing", () => {
	it("decodes fragmented and compressed frames without losing boundaries", () => {
		const first = encodeConnectFrame(new TextEncoder().encode("alpha"));
		const compressed = encodeConnectFrame(gzipSync("beta"), CONNECT_COMPRESSED_FLAG | CONNECT_END_STREAM_FLAG);
		const wire = Buffer.concat([first, compressed]);
		const reader = createConnectFrameReader();
		expect(reader.push(wire.subarray(0, 3))).toEqual([]);
		const frames = reader.push(wire.subarray(3));
		expect(frames.map(frame => new TextDecoder().decode(frame.payload))).toEqual(["alpha", "beta"]);
		expect(frames.map(frame => frame.endOfStream)).toEqual([false, true]);
	});

	it("rejects a declared payload above the configured bound before buffering it", () => {
		const frame = encodeConnectFrame(new Uint8Array(9));
		const reader = createConnectFrameReader({ maxPayloadBytes: 8 });
		expect(() => reader.push(frame.subarray(0, 5))).toThrow("exceeds 8 bytes");
	});

	it("rejects a clean close with a truncated Connect header", () => {
		const reader = createConnectFrameReader();
		expect(reader.push(new Uint8Array([0, 0, 0]))).toEqual([]);
		expect(() => reader.finish()).toThrow("incomplete frame header (3 of 5 bytes)");
	});

	it("rejects a clean close with a truncated Connect payload", () => {
		const reader = createConnectFrameReader();
		const frame = encodeConnectFrame(new Uint8Array([1, 2, 3]));
		expect(reader.push(frame.subarray(0, -1))).toEqual([]);
		expect(() => reader.finish()).toThrow("incomplete frame payload (2 of 3 bytes)");
	});

	it("accepts a complete terminal frame at a clean close", () => {
		const reader = createConnectFrameReader();
		const frames = reader.push(encodeConnectFrame(new Uint8Array(0), CONNECT_END_STREAM_FLAG));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.endOfStream).toBe(true);
		expect(() => reader.finish()).not.toThrow();
	});

	it("extracts structured trailer errors and ignores successful trailers", () => {
		const error = new TextEncoder().encode(
			JSON.stringify({ error: { code: "permission_denied", message: "account unavailable" } }),
		);
		expect(readConnectTrailerError(error)).toEqual({ code: "permission_denied", message: "account unavailable" });
		expect(readConnectTrailerError(new TextEncoder().encode("{}"))).toBeNull();
	});
});

describe("shared HTTP/1 bridge", () => {
	it("cancels an in-flight append before close resolves", async () => {
		const appendStarted = Promise.withResolvers<void>();
		let appendAborted = false;
		const bridge = await createHttp1Bridge({
			baseUrl: "http://127.0.0.1",
			provider: "transport-test",
			headers: {},
			requestBytes: new Uint8Array([1]),
			createRpc(_transport: Transport) {
				return {
					async append(_seqno, _data, signal) {
						appendStarted.resolve();
						try {
							await abortPromise(signal);
						} catch {
							appendAborted = true;
							throw new Error("append aborted");
						}
					},
					async *receive(signal) {
						await abortPromise(signal);
						yield* [];
					},
					async *poll() {
						yield* [];
					},
					decodePoll(data) {
						return data;
					},
				};
			},
		});
		await appendStarted.promise;
		await bridge.close("dispose");
		expect(appendAborted).toBeTrue();
	});

	it("does not decode or re-enqueue an accepted poll retransmission", async () => {
		let executions = 0;
		const bridge = await createHttp1Bridge({
			baseUrl: "http://127.0.0.1",
			provider: "transport-test",
			headers: {},
			requestBytes: new Uint8Array(),
			createRpc() {
				return {
					async append() {},
					async *receive() {
						yield* [];
					},
					async *poll() {
						yield { seqno: 0n, data: "exec-0", eof: false };
						yield { seqno: 0n, data: "exec-0", eof: false };
						yield { seqno: 1n, data: "exec-1", eof: true };
					},
					decodePoll(data) {
						executions++;
						return data;
					},
				};
			},
		});
		const messages: string[] = [];
		for await (const message of bridge.messages) messages.push(message);
		expect(messages).toEqual(["exec-0", "exec-1"]);
		expect(executions).toBe(2);
	});

	it("surfaces poll sequence violations as fatal errors", async () => {
		const bridge = await createHttp1Bridge({
			baseUrl: "http://127.0.0.1",
			provider: "transport-test",
			headers: {},
			requestBytes: new Uint8Array(),
			createRpc() {
				return {
					async append() {},
					async *receive() {
						yield* [];
					},
					async *poll() {
						yield { seqno: 0n, data: "first", eof: false };
						yield { seqno: 2n, data: "gap", eof: false };
					},
					decodePoll(data) {
						return data;
					},
				};
			},
		});
		const iterator = bridge.messages[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({ value: "first", done: false });
		await expect(iterator.next()).rejects.toThrow("poll sequence violation");
	});

	it("surfaces receive and poll failures instead of ending normally", async () => {
		for (const failureAt of ["receive", "poll"] as const) {
			const fatal = new Error(`${failureAt} failed`);
			const bridge = await createHttp1Bridge({
				baseUrl: "http://127.0.0.1",
				provider: "transport-test",
				headers: {},
				requestBytes: new Uint8Array(),
				createRpc() {
					return {
						async append() {},
						async *receive() {
							if (failureAt === "receive") throw fatal;
							yield* [];
						},
						async *poll() {
							if (failureAt === "poll") throw fatal;
							yield* [];
						},
						decodePoll(data) {
							return data;
						},
					};
				},
			});
			const iterator = bridge.messages[Symbol.asyncIterator]();
			await expect(iterator.next()).rejects.toBe(fatal);
		}
	});

	it("normalizes authentication failures at every RPC boundary to a status-bearing credential error", async () => {
		for (const failureAt of ["append", "receive", "poll"] as const) {
			const bridge = await createHttp1Bridge({
				baseUrl: "http://127.0.0.1",
				provider: "transport-test",
				headers: {},
				requestBytes: new Uint8Array(),
				normalizeError: error =>
					normalizeConnectAuthError(error, (message, status) => new CursorCredentialError(message, status)),
				createRpc() {
					return {
						async append() {
							if (failureAt === "append") throw new ConnectError("denied", Code.Unauthenticated);
						},
						async *receive(signal) {
							if (failureAt === "receive") throw new ConnectError("denied", Code.Unauthenticated);
							if (failureAt === "append") await abortPromise(signal);
							yield* [];
						},
						async *poll() {
							if (failureAt === "poll") throw new ConnectError("denied", Code.Unauthenticated);
							yield* [];
						},
						decodePoll(data) {
							return data;
						},
					};
				},
			});
			try {
				await bridge.messages[Symbol.asyncIterator]().next();
			} catch (error) {
				expect(error).toBeInstanceOf(CursorCredentialError);
				expect((error as CursorCredentialError).status).toBe(401);
				continue;
			}
			throw new Error(`Expected an authentication failure from ${failureAt}`);
		}
	});
});

describe("shared HTTP/2 pool", () => {
	it("leases pooled sessions and safely releases a lease twice", async () => {
		const sessions: http2.ServerHttp2Session[] = [];
		const { baseUrl, server } = await listen((stream, headers) => {
			expect(headers.te).toBe("trailers");
			stream.respond({ ":status": 200 });
			stream.end("ok");
		});
		server.on("session", session => sessions.push(session));

		for (let index = 0; index < 5; index++) {
			const lease = await acquireH2Session(baseUrl, "transport-test");
			const request = await lease.request({ ":method": "POST", ":path": "/run" });
			request.end();
			expect(await readAll(request)).toBe("ok");
			lease.release();
			lease.release();
		}
		expect(sessions).toHaveLength(4);
	});

	it("preserves the originating connection error when every slot fails", async () => {
		const { baseUrl, server } = await listen(() => {});
		const { promise: closed, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await closed;
		servers.delete(server);

		try {
			await acquireH2Session(baseUrl, "transport-test");
		} catch (error) {
			expect(error && typeof error === "object" && "code" in error ? error.code : undefined).toBe("ECONNREFUSED");
			return;
		}
		throw new Error("Expected HTTP/2 acquisition to fail");
	});

	it("disposal closes active streams before it resolves", async () => {
		const { baseUrl } = await listen(stream => {
			stream.respond({ ":status": 200 });
		});
		const lease = await acquireH2Session(baseUrl, "transport-test");
		const request = await lease.request({ ":method": "POST", ":path": "/hang" });
		request.end();
		const { promise: closed, resolve } = Promise.withResolvers<void>();
		request.once("close", () => resolve());
		const firstDisposal = disposeH2Pool();
		const concurrentDisposal = disposeH2Pool();
		expect(concurrentDisposal).toBe(firstDisposal);
		await firstDisposal;
		await closed;
		lease.release();
		expect(request.closed || request.destroyed).toBeTrue();
	});
});

describe("shared transport lifecycle", () => {
	it("awaits registered disposers before resolving", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { disposeTransports, isTransportDisposed, registerTransportDisposer } from "./src/transport/lifecycle.ts";
let drained = false;
registerTransportDisposer("probe", () => {
	const { promise, resolve } = Promise.withResolvers();
	queueMicrotask(() => {
		drained = true;
		resolve();
	});
	return promise;
});
await disposeTransports();
process.stdout.write(JSON.stringify({ drained, disposed: isTransportDisposed() }));`,
			],
			{ cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ drained: true, disposed: true });
	});
});

describe("shared transport classification", () => {
	it("classifies replay-safe network and HTTP failures but excludes auth and cancellation", () => {
		expect(isTransientTransportError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBeTrue();
		expect(isTransientTransportError(Object.assign(new Error("unavailable"), { status: 503 }))).toBeTrue();
		expect(isTransientTransportError(Object.assign(new Error("forbidden"), { status: 403 }))).toBeFalse();
		expect(isTransientTransportError(new DOMException("aborted", "AbortError"))).toBeFalse();
	});
});
