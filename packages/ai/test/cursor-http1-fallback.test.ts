import { afterEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import { disposeServerConfigCache, resolveCursorTransportMode } from "../src/providers/cursor/server-config";

const servers = new Set<http.Server>();

afterEach(async () => {
	await disposeServerConfigCache();
	await Promise.all(
		Array.from(servers, server => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		}),
	);
	servers.clear();
});

async function unavailableDiscoveryServer(): Promise<string> {
	const server = http.createServer((_request, response) => {
		response.writeHead(404);
		response.end();
	});
	servers.add(server);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
	return `http://127.0.0.1:${address.port}`;
}

describe("Cursor HTTP/1 fallback selection", () => {
	it("honors the per-request HTTP/1 preference when config discovery fails", async () => {
		const baseUrl = await unavailableDiscoveryServer();
		const result = await resolveCursorTransportMode({
			baseUrl,
			apiKey: "test-key",
			provider: "cursor",
			useHttp1ForAgent: true,
			originalRequestId: crypto.randomUUID(),
		});
		expect(result.mode).toBe("http1");
	});
});
