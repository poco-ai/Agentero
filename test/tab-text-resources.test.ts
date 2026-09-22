import { describe, expect, it, vi } from "vitest";
import { loadTabResources } from "@/lib/workspace/tabs/resources";

const source = '{\n  "citations": [{ "raw": "a *literal* citation" }]\n}\n';

vi.mock("@/lib/vault", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault")>()),
	ensureLocalFsScope: vi.fn(),
	readVaultFile: vi.fn(async () => source),
}));

vi.mock("@/lib/paper", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/paper")>()),
	detectPaperDirectory: vi.fn(async () => false),
	loadPaperOpenBundle: vi.fn(async () => null),
	loadPaperMetadata: vi.fn(async () => null),
	findLocalPdfPath: vi.fn(async () => null),
}));

describe("paper text file resources", () => {
	it.each([
		{ paperFolders: [] },
		{ paperFolders: ["/vault/papers/example"] },
	])("loads JSON unchanged into the text buffer with known paper folders %j", async ({
		paperFolders,
	}) => {
		const resources = await loadTabResources(
			"/vault/papers/example/source/agentero-cite.json",
			"/vault",
			[],
			paperFolders,
		);
		expect(resources.kind).toBe("file");
		expect(resources.mode).toBe("text");
		expect(resources.textSeed).toBe(source);
		expect(resources.markdownSeed).toBe("");
	});

	it("restores an unknown-extension attachment before the tree is loaded", async () => {
		const resources = await loadTabResources(
			"/vault/papers/example/attachments/data.log",
			"/vault",
			[],
			["/vault/papers/example"],
		);
		expect(resources.kind).toBe("file");
		expect(resources.mode).toBe("text");
		expect(resources.textSeed).toBe(source);
	});

	it("keeps paper notes in the Markdown buffer", async () => {
		const resources = await loadTabResources(
			"/vault/papers/example/NOTES.md",
			"/vault",
			[],
			["/vault/papers/example"],
		);
		expect(resources.mode).toBe("markdown");
		expect(resources.markdownSeed).toBe(source);
	});
});
