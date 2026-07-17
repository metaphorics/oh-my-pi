import { describe, expect, it, vi } from "bun:test";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { BlobStore } from "../src/session/blob-store";
import type { FileEntry } from "../src/session/session-entries";
import { resolveBlobRefsInEntries } from "../src/session/session-loader";

const ref = (hash: string): string => `blob:sha256:${hash}`;

function messageEntry(message: object): FileEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: "2026-07-17T00:00:00.000Z",
		message,
	} as FileEntry;
}

class ScriptedStore extends BlobStore {
	readonly reads: string[] = [];

	constructor(
		dir: string,
		private readonly read: (hash: string) => Promise<Buffer | null>,
	) {
		super(dir);
	}

	override async get(hash: string): Promise<Buffer | null> {
		this.reads.push(hash);
		return this.read(hash);
	}
}

describe("blob resolver optimization invariants", () => {
	it("retains the matched-payload early return", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-early-return-");
		const store = new ScriptedStore(tempDir.path(), async hash => Buffer.from(hash));
		const image = {
			type: "image",
			data: ref("payload"),
			mimeType: "image/png",
			image_url: ref("nested-provider-url"),
		};

		await resolveBlobRefsInEntries([messageEntry({ role: "user", content: [image] })], store);

		expect(image.data).toBe(Buffer.from("payload").toString("base64"));
		expect(image.image_url).toBe(ref("nested-provider-url"));
		expect(store.reads).toEqual(["payload"]);
	});

	it("retains the content/images key gate", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-key-gate-");
		const store = new ScriptedStore(tempDir.path(), async hash => Buffer.from(hash));
		const metadataImage = { type: "image", data: ref("metadata"), mimeType: "image/png" };
		const contentImage = { type: "image", data: ref("content"), mimeType: "image/png" };

		await resolveBlobRefsInEntries(
			[messageEntry({ role: "user", metadata: metadataImage, content: [contentImage] })],
			store,
		);

		expect(metadataImage.data).toBe(ref("metadata"));
		expect(contentImage.data).toBe(Buffer.from("content").toString("base64"));
		expect(store.reads).toEqual(["content"]);
	});

	it("ignores inherited traversal keys", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-own-keys-");
		const store = new ScriptedStore(tempDir.path(), async hash => Buffer.from(hash));
		const inheritedImage = { type: "image", data: ref("inherited"), mimeType: "image/png" };
		const wrapper = Object.create({ content: [inheritedImage] }) as Record<string, object>;
		wrapper.own = { note: "plain" };

		await resolveBlobRefsInEntries([messageEntry({ role: "toolResult", details: wrapper })], store);

		expect(inheritedImage.data).toBe(ref("inherited"));
		expect(store.reads).toEqual([]);
	});

	it("preserves warning order across result, image_url, and descendants", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-warning-order-");
		const slowResult = Promise.withResolvers<Buffer | null>();
		const store = new ScriptedStore(tempDir.path(), async hash =>
			hash === "slow-result" ? slowResult.promise : null,
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const node = {
			type: "image_generation_call",
			result: ref("slow-result"),
			image_url: ref("provider-url"),
			content: [{ type: "image", data: ref("child-image"), mimeType: "image/png" }],
		};

		try {
			const resolving = resolveBlobRefsInEntries([messageEntry({ role: "assistant", node })], store);
			expect(store.reads).toEqual(["slow-result"]);
			slowResult.resolve(null);
			await resolving;
			expect(warn.mock.calls.map(([message, fields]) => [message, fields?.hash])).toEqual([
				["Blob not found for image reference", "slow-result"],
				["Blob not found for persisted image data URL", "provider-url"],
				["Blob not found for image reference", "child-image"],
			]);
			expect(store.reads).toEqual(["slow-result", "provider-url", "child-image"]);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not snapshot aliased descendant refs before their dependency", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-shared-mutation-");
		const parentResponse = Promise.withResolvers<Buffer | null>();
		const sharedMutation = Promise.withResolvers<void>();
		let sharedReads = 0;
		const store = new ScriptedStore(tempDir.path(), async hash => {
			if (hash === "parent") return parentResponse.promise;
			if (hash === "shared") {
				sharedReads += 1;
				if (sharedReads > 1) throw new Error("duplicate shared read");
				return Buffer.from("shared");
			}
			throw new Error(`unexpected read: ${hash}`);
		});
		let sharedData = ref("shared");
		const shared = {
			type: "image",
			get data(): string {
				return sharedData;
			},
			set data(value: string) {
				sharedData = value;
				sharedMutation.resolve();
			},
			mimeType: "image/png",
		};
		const message = {
			role: "assistant",
			immediate: { content: [shared] },
			delayed: {
				type: "image_generation_call",
				result: ref("parent"),
				content: [shared],
			},
		};

		const resolving = resolveBlobRefsInEntries([messageEntry(message)], store);
		await sharedMutation.promise;
		parentResponse.resolve(Buffer.from("parent"));
		await resolving;

		expect(sharedReads).toBe(1);
		expect(shared.data).toBe(Buffer.from("shared").toString("base64"));
		expect(message.delayed.result).toBe(Buffer.from("parent").toString("base64"));
		expect(store.reads).toEqual(["shared", "parent"]);
	});

	it("scans each entry at the original map initiation point", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-entry-mutation-");
		const secondMessage: {
			role: string;
			content: string | Array<{ type: string; data: string; mimeType: string }>;
		} = { role: "user", content: "plain before the first read starts" };
		const store = new ScriptedStore(tempDir.path(), async hash => {
			if (hash === "first") {
				secondMessage.content = [{ type: "image", data: ref("second"), mimeType: "image/png" }];
				return Buffer.from("first");
			}
			if (hash === "second") return Buffer.from("second");
			throw new Error(`unexpected read: ${hash}`);
		});
		const firstImage = { type: "image", data: ref("first"), mimeType: "image/png" };

		await resolveBlobRefsInEntries(
			[messageEntry({ role: "user", content: [firstImage] }), messageEntry(secondMessage)],
			store,
		);

		expect(Array.isArray(secondMessage.content)).toBe(true);
		if (!Array.isArray(secondMessage.content)) throw new Error("entry mutation was not applied");
		expect(secondMessage.content[0]?.data).toBe(Buffer.from("second").toString("base64"));
		expect(store.reads).toEqual(["first", "second"]);
	});
});
