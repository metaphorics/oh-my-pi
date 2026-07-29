import { describe, expect, it } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { fetchDevinModels } from "../src/discovery/devin";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "../src/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	ClientModelConfigSchema,
	ModelInfoSchema,
} from "../src/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

const SESSION_TOKEN = "devin-session-token$fixture";

describe("fetchDevinModels", () => {
	it("uses the current Devin CLI identity and Basic session credential", async () => {
		const response = create(GetCliModelConfigsResponseSchema, {
			clientModelConfigs: [
				create(ClientModelConfigSchema, {
					modelUid: "observed-model",
					label: "Observed Model",
					modelInfo: create(ModelInfoSchema, { maxTokens: 1_000_000, maxOutputTokens: 128_000 }),
				}),
			],
		});
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		let requestBody: Uint8Array | undefined;
		const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestBody = new Uint8Array(init?.body as ArrayBuffer);
			return new Response(toBinary(GetCliModelConfigsResponseSchema, response), { status: 200 });
		};

		const models = await fetchDevinModels({ apiKey: "fixture", baseUrl: "https://example.test", fetch });

		expect(models).toEqual([
			expect.objectContaining({ id: "observed-model", contextWindow: 1_000_000, maxTokens: 128_000 }),
		]);
		expect(requestUrl).toBe("https://example.test/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
		expect(requestHeaders?.get("authorization")).toBe(`Basic ${SESSION_TOKEN}`);
		expect(requestHeaders?.get("content-type")).toBe("application/proto");
		if (!requestBody) throw new Error("Devin discovery did not submit a request body");
		const request = fromBinary(GetCliModelConfigsRequestSchema, requestBody);
		expect(request.metadata).toMatchObject({
			apiKey: SESSION_TOKEN,
			ideName: "chisel",
			ideVersion: "0.0.0-dev",
			extensionName: "chisel",
			extensionVersion: "0.0.0-dev",
			locale: "en",
			os: process.platform,
		});
	});
});
