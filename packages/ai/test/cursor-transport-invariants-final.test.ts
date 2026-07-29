import { describe, expect, it } from "bun:test";
import * as http from "node:http";
import * as http2 from "node:http2";
import type * as net from "node:net";
import * as path from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { BidiAppendResponseSchema, BidiPollResponseSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/bidi_pb";
import {
	__evictH2PoolEntry,
	__getH2PoolStats,
	__getH2PoolStatsForOrigin,
	acquireH2Session,
} from "../src/providers/cursor/h2-pool";
import { type CursorHttp1Bridge, createCursorHttp1Bridge } from "../src/providers/cursor/http1-bridge";

function textDeltaMessage(text: string) {
	return create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
			}),
		},
	});
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function endStreamFrame(): Buffer {
	return frameConnectMessage(Buffer.from(JSON.stringify({}), "utf8"), 2);
}

/**
 * A Connect end-stream frame carrying a server error. Returns HTTP 200 with
 * Content-Type application/connect+proto so the connection is not torn down
 * by an HTTP error status. The error is encoded in the end-stream JSON body
 * as { error: { code, message } }, which ConnectRPC parses into a ConnectError.
 * `Connection: close` prevents Bun's HTTP/1.1 keep-alive from reusing the
 * connection for the concurrent BidiAppend request.
 */
function connectErrorEndStreamFrame(code: string, message: string): Buffer {
	const json = JSON.stringify({ error: { code, message } });
	return frameConnectMessage(Buffer.from(json, "utf8"), 0x02);
}

async function closeServerAsync(server: net.Server | http.Server): Promise<void> {
	(server as http.Server).closeAllConnections?.();
	server.unref();
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	await promise;
}

describe("Invariant 1: H2 Pool Lease Release Authoritative After Eviction", () => {
	it("decrements retiring manager lease count and aborts at zero when lease released after eviction", async () => {
		const server = http2.createServer();
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address() as net.AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;

		try {
			const lease = await acquireH2Session(baseUrl, "cursor");
			expect(lease).toBeDefined();

			const initialStats = __getH2PoolStatsForOrigin(baseUrl, "cursor");
			expect(initialStats.poolCount).toBe(1);

			// Evict the pool entry while lease is active — key-scoped, no
			// process-global disposal so concurrent test files are unaffected.
			__evictH2PoolEntry(baseUrl, "cursor");

			// Pool entry should be gone (poolCount 0), manager moved to retiring.
			const globalStats1 = __getH2PoolStats();
			expect(globalStats1.poolCount).toBe(0);
			expect(globalStats1.retiringCount).toBe(1);

			// Release the lease.
			lease.release();

			// Retiring manager should be removed and aborted.
			const globalStats2 = __getH2PoolStats();
			expect(globalStats2.retiringCount).toBe(0);

			// Double release should be idempotent.
			lease.release();
			expect(__getH2PoolStats().retiringCount).toBe(0);
		} finally {
			await closeServerAsync(server);
		}
	});
});

describe("Invariant 2: GetServerConfig and H1 bridge honor proxy policy and precedence", () => {
	it("honors proxy precedence, NO_PROXY bypass, and server config HTTP/1 in an isolated subprocess", async () => {
		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/cursor-proxy-config-invariant.ts")],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(stderr.trim()).toBe("");
		expect(exitCode).toBe(0);

		const result = JSON.parse(stdout) as {
			ok: boolean;
			steps: Array<{ name: string; passed: boolean; expected: string; actual: string }>;
		};
		expect(result.ok).toBe(true);
		expect(result.steps.length).toBe(6);
		for (const step of result.steps) {
			expect(step.passed).toBe(true);
		}

		// Verify exact expected values for each step.
		const byName = new Map(result.steps.map(s => [s.name, s]));
		expect(byName.get("HTTPS_PROXY")?.actual).toBe("http://proxy-https:8080");
		expect(byName.get("PI_PROXY > HTTPS_PROXY")?.actual).toBe("http://proxy-pi:8080");
		expect(byName.get("PI_PROXY_CURSOR > PI_PROXY")?.actual).toBe("http://proxy-cursor:8080");
		expect(byName.get("NO_PROXY bypass match")?.actual).toBe("true");
		expect(byName.get("NO_PROXY bypass no-match")?.actual).toBe("false");
		expect(byName.get("GetServerConfig HTTP/1 mode")?.actual).toBe("http1");
	});
});

describe("Invariant 2: H1 fatal errors preserve Connect status", () => {
	it("propagates an unavailable SSE error through bridge.messages", async () => {
		const mockServer = http.createServer((req, res) => {
			if (req.url?.includes("BidiAppend")) {
				res.writeHead(200, { "Content-Type": "application/proto", Connection: "close" });
				res.end(toBinary(BidiAppendResponseSchema, create(BidiAppendResponseSchema, {})));
				return;
			}
			if (req.url?.includes("RunSSE")) {
				res.writeHead(200, { "Content-Type": "application/connect+proto", Connection: "close" });
				res.end(connectErrorEndStreamFrame("unavailable", "transient transport failure"));
				return;
			}
			res.writeHead(404, { Connection: "close" });
			res.end();
		});
		const listening = Promise.withResolvers<void>();
		mockServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const baseUrl = `http://127.0.0.1:${(mockServer.address() as net.AddressInfo).port}`;
		let bridge: CursorHttp1Bridge | undefined;

		try {
			bridge = await createCursorHttp1Bridge({
				baseUrl,
				apiKey: "test-key",
				provider: "cursor",
				originalRequestId: "orig-1",
				requestId: "req-1",
				requestBytes: new Uint8Array(),
			});
			let thrown: unknown;
			try {
				for await (const _message of bridge.messages) {
					// Drain until the fatal transport error closes the bridge.
				}
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ConnectError);
			if (thrown instanceof ConnectError) expect(thrown.code).toBe(Code.Unavailable);
		} finally {
			await bridge?.close("dispose");
			await closeServerAsync(mockServer);
		}
	});
});

describe("Invariant 3: Poll Sequence Validation", () => {
	it("delivers a byte-identical retransmit exactly once and rejects a second consecutive duplicate", async () => {
		const msg1Bytes = toBinary(AgentServerMessageSchema, textDeltaMessage("hello"));
		const msg2Bytes = toBinary(AgentServerMessageSchema, textDeltaMessage("world"));

		let pollCallCount = 0;
		const mockServer = http.createServer((req, res) => {
			if (req.url?.includes("BidiAppend")) {
				const body = toBinary(BidiAppendResponseSchema, create(BidiAppendResponseSchema, {}));
				res.writeHead(200, { "Content-Type": "application/proto", Connection: "close" });
				res.end(body);
			} else if (req.url?.includes("RunPoll")) {
				pollCallCount++;
				res.writeHead(200, { "Content-Type": "application/connect+proto", Connection: "close" });

				if (pollCallCount === 1) {
					// Return seqno 0n, seqno 0n (byte identical dup), seqno 1n
					const r1 = create(BidiPollResponseSchema, {
						seqno: 0n,
						data: Buffer.from(msg1Bytes).toString("base64"),
					});
					const r2 = create(BidiPollResponseSchema, {
						seqno: 0n,
						data: Buffer.from(msg1Bytes).toString("base64"),
					});
					const r3 = create(BidiPollResponseSchema, {
						seqno: 1n,
						data: Buffer.from(msg2Bytes).toString("base64"),
						eof: true,
					});

					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r1)));
					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r2)));
					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r3)));
					res.end(endStreamFrame());
				}
			} else if (req.url?.includes("RunSSE") || req.url?.includes("Run")) {
				// Return a 200 with a Connect end-stream error frame so the
				// HTTP connection is not torn down by an error status (which
				// would corrupt the keep-alive connection for BidiAppend).
				// The ConnectError(code=unimplemented) triggers Poll fallback.
				res.writeHead(200, { "Content-Type": "application/connect+proto", Connection: "close" });
				res.end(connectErrorEndStreamFrame("unimplemented", "unimplemented"));
			} else {
				res.writeHead(404, { Connection: "close" });
				res.end();
			}
		});

		const listening = Promise.withResolvers<void>();
		mockServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const baseUrl = `http://127.0.0.1:${(mockServer.address() as net.AddressInfo).port}`;
		let bridge: CursorHttp1Bridge | undefined;

		try {
			bridge = await createCursorHttp1Bridge({
				baseUrl,
				apiKey: "test-key",
				provider: "cursor",
				originalRequestId: "orig-1",
				requestId: "req-1",
				requestBytes: new Uint8Array(),
			});

			const received: string[] = [];
			for await (const msg of bridge.messages) {
				if (msg.message.case === "interactionUpdate" && msg.message.value.message.case === "textDelta") {
					received.push(msg.message.value.message.value.text);
				}
			}

			// The seqno 0n retransmit advances the poll but is not re-delivered:
			// re-enqueuing it would render text twice and run an exec frame twice.
			expect(received).toEqual(["hello", "world"]);
		} finally {
			await bridge?.close("success").catch(() => {});
			await closeServerAsync(mockServer);
		}
	});

	it("rejects altered duplicate content without enqueuing", async () => {
		const msg1Bytes = toBinary(AgentServerMessageSchema, textDeltaMessage("hello"));
		const msgAlteredBytes = toBinary(AgentServerMessageSchema, textDeltaMessage("altered"));

		let pollCallCount = 0;
		const mockServer = http.createServer((req, res) => {
			if (req.url?.includes("BidiAppend")) {
				const body = toBinary(BidiAppendResponseSchema, create(BidiAppendResponseSchema, {}));
				res.writeHead(200, { "Content-Type": "application/proto", Connection: "close" });
				res.end(body);
			} else if (req.url?.includes("RunPoll")) {
				pollCallCount++;
				res.writeHead(200, { "Content-Type": "application/connect+proto", Connection: "close" });

				if (pollCallCount === 1) {
					// Return seqno 0n (hello), seqno 0n (altered content!)
					const r1 = create(BidiPollResponseSchema, {
						seqno: 0n,
						data: Buffer.from(msg1Bytes).toString("base64"),
					});
					const r2 = create(BidiPollResponseSchema, {
						seqno: 0n,
						data: Buffer.from(msgAlteredBytes).toString("base64"),
					});

					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r1)));
					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r2)));
					res.end(endStreamFrame());
				}
			} else if (req.url?.includes("RunSSE") || req.url?.includes("Run")) {
				res.writeHead(200, { "Content-Type": "application/connect+proto", Connection: "close" });
				res.end(connectErrorEndStreamFrame("unimplemented", "unimplemented"));
			} else {
				res.writeHead(404, { Connection: "close" });
				res.end();
			}
		});

		const listening = Promise.withResolvers<void>();
		mockServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const baseUrl = `http://127.0.0.1:${(mockServer.address() as net.AddressInfo).port}`;

		let bridge: CursorHttp1Bridge | undefined;
		try {
			bridge = await createCursorHttp1Bridge({
				baseUrl,
				apiKey: "test-key",
				provider: "cursor",
				originalRequestId: "orig-2",
				requestId: "req-2",
				requestBytes: new Uint8Array(),
			});

			const received: string[] = [];
			let thrown: unknown;
			try {
				for await (const msg of bridge.messages) {
					if (msg.message.case === "interactionUpdate" && msg.message.value.message.case === "textDelta") {
						received.push(msg.message.value.message.value.text);
					}
				}
			} catch (error) {
				thrown = error;
			}

			// "hello" was received; "altered" was rejected before enqueueing and bridge closed fatal
			expect(received).toEqual(["hello"]);
			expect(String(thrown)).toContain("Cursor HTTP/1 poll sequence violation: altered duplicate");
		} finally {
			await bridge?.close("success").catch(() => {});
			await closeServerAsync(mockServer);
		}
	});

	it("rejects second consecutive duplicate without enqueuing", async () => {
		const msg1Bytes = toBinary(AgentServerMessageSchema, textDeltaMessage("hello"));

		let pollCallCount = 0;
		const mockServer = http.createServer((req, res) => {
			if (req.url?.includes("BidiAppend")) {
				const body = toBinary(BidiAppendResponseSchema, create(BidiAppendResponseSchema, {}));
				res.writeHead(200, { "Content-Type": "application/proto", Connection: "close" });
				res.end(body);
			} else if (req.url?.includes("RunPoll")) {
				pollCallCount++;
				res.writeHead(200, { "Content-Type": "application/connect+proto", Connection: "close" });

				if (pollCallCount === 1) {
					// Return seqno 0n, 0n (1st dup), 0n (2nd dup - REJECT!)
					const r1 = create(BidiPollResponseSchema, {
						seqno: 0n,
						data: Buffer.from(msg1Bytes).toString("base64"),
					});
					const r2 = create(BidiPollResponseSchema, {
						seqno: 0n,
						data: Buffer.from(msg1Bytes).toString("base64"),
					});
					const r3 = create(BidiPollResponseSchema, {
						seqno: 0n,
						data: Buffer.from(msg1Bytes).toString("base64"),
					});

					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r1)));
					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r2)));
					res.write(frameConnectMessage(toBinary(BidiPollResponseSchema, r3)));
					res.end(endStreamFrame());
				}
			} else if (req.url?.includes("RunSSE") || req.url?.includes("Run")) {
				res.writeHead(200, { "Content-Type": "application/connect+proto", Connection: "close" });
				res.end(connectErrorEndStreamFrame("unimplemented", "unimplemented"));
			} else {
				res.writeHead(404, { Connection: "close" });
				res.end();
			}
		});

		const listening = Promise.withResolvers<void>();
		mockServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const baseUrl = `http://127.0.0.1:${(mockServer.address() as net.AddressInfo).port}`;

		let bridge: CursorHttp1Bridge | undefined;
		try {
			bridge = await createCursorHttp1Bridge({
				baseUrl,
				apiKey: "test-key",
				provider: "cursor",
				originalRequestId: "orig-3",
				requestId: "req-3",
				requestBytes: new Uint8Array(),
			});

			const received: string[] = [];
			let thrown: unknown;
			try {
				for await (const msg of bridge.messages) {
					if (msg.message.case === "interactionUpdate" && msg.message.value.message.case === "textDelta") {
						received.push(msg.message.value.message.value.text);
					}
				}
			} catch (error) {
				thrown = error;
			}

			// First 0n enqueued once; the 1st retransmit is discarded and the
			// 2nd consecutive duplicate is a fatal sequence violation.
			expect(received).toEqual(["hello"]);
			expect(String(thrown)).toContain("Cursor HTTP/1 poll sequence violation: second consecutive duplicate");
		} finally {
			await bridge?.close("success").catch(() => {});
			await closeServerAsync(mockServer);
		}
	});
});

describe("Invariant 4: Composite Dispose Owns One Promise", () => {
	it("returns identical promise for concurrent and subsequent calls and awaits teardown in an isolated subprocess", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "../../coding-agent/test/fixtures/cursor-composite-disposal.ts"),
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(stderr.trim()).toBe("");
		expect(exitCode).toBe(0);

		const result = JSON.parse(stdout) as {
			ok: boolean;
			disposalBlocksNewWork: boolean;
			promiseIdentity: boolean;
			promisePendingBeforeRelease: boolean;
			promiseAwaitsTeardown: boolean;
			subsequentCallIdentity: boolean;
		};
		expect(result.ok).toBe(true);
		expect(result.disposalBlocksNewWork).toBe(true);
		expect(result.promiseIdentity).toBe(true);
		expect(result.promisePendingBeforeRelease).toBe(true);
		expect(result.promiseAwaitsTeardown).toBe(true);
		expect(result.subsequentCallIdentity).toBe(true);
	});
});
