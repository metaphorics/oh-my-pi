import { describe, expect, test } from "bun:test";
import { fetchKiroModels } from "../src/discovery/kiro";

const fixture = await Bun.file(new URL("./fixtures/kiro-list-available-models.json", import.meta.url)).text();

describe("fetchKiroModels", () => {
	test("normalizes only the model ids returned by the recorded Kiro catalog", async () => {
		let request: Request | undefined;
		const models = await fetchKiroModels({
			apiKey: JSON.stringify({ accessToken: "token", profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test" }),
			fetch: async (input, init) => {
				request = new Request(input, init);
				return new Response(fixture, { headers: { "content-type": "application/x-amz-json-1.0" } });
			},
		});

		expect(request?.url).toBe(
			"https://management.us-east-1.kiro.dev/?origin=KIRO_CLI&profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123%3Aprofile%2Ftest",
		);
		expect(request?.headers.get("authorization")).toBe("Bearer token");
		expect(request?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
		expect(models?.map(model => model.id)).toContain("gpt-5.6-sol");
		expect(models?.map(model => model.id)).toContain("claude-opus-4.8");
		expect(models).toHaveLength(19);
	});
});
