import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readDir, platform } = vi.hoisted(() => ({
	readDir: vi.fn(),
	platform: { isTauri: false },
}));
vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tauri-apps/plugin-fs")>()),
	readDir,
}));
vi.mock("@/lib/core/tauri", async () => ({
	...(await import("./helpers/tauri")).makeTauriPlatform(),
	isTauri: () => platform.isTauri,
}));

import {
	clearPaperTitleLookup,
	joinTaskDetail,
	paperTaskLabel,
	registerPaperTitleLookup,
} from "@/lib/core/task-label";
import { libraryStore } from "@/lib/paper/library-store";
import { looksLikeTitleSearchQuery } from "@/lib/paper/lookup";
import { canonicalPaperPdfPath, findLocalPdfPath } from "@/lib/paper/media";
import {
	buildPaperReaderUserPrompt,
	paperReaderLanguageInstruction,
} from "@/lib/paper/reader";
// Ensure the catalog lookup is wired the same way as the app.
import "@/lib/paper/task-label";
import { withPaperTagColor } from "@/lib/paper/tags";
import { isLocalHtmlLink } from "@/lib/workspace/viewer-actions";

describe("canonical paper PDF", () => {
	beforeEach(() => {
		platform.isTauri = true;
	});
	afterEach(() => {
		platform.isTauri = false;
	});

	it("prefers the canonical root PDF and never opens source illustrations", async () => {
		readDir.mockResolvedValueOnce([
			{ name: "source", isDirectory: true },
			{ name: "a.pdf", isFile: true },
			{ name: "demo.pdf", isFile: true },
		]);
		expect(await findLocalPdfPath("/vault/papers/demo")).toBe(
			"/vault/papers/demo/demo.pdf",
		);
		readDir.mockResolvedValueOnce([{ name: "source", isDirectory: true }]);
		expect(await findLocalPdfPath("/vault/papers/demo")).toBeNull();
	});

	it("uses the paper folder name as {id}.pdf at the paper root", () => {
		expect(canonicalPaperPdfPath("/vault/papers/2401.12345")).toBe(
			"/vault/papers/2401.12345/2401.12345.pdf",
		);
		expect(canonicalPaperPdfPath("/vault/papers/2401.12345/")).toBe(
			"/vault/papers/2401.12345/2401.12345.pdf",
		);
		expect(canonicalPaperPdfPath("C:\\vault\\papers\\demo")).toBe(
			"C:\\vault\\papers\\demo\\demo.pdf",
		);
		expect(canonicalPaperPdfPath("remote:sess/papers/abc")).toBe(
			"remote:sess/papers/abc/abc.pdf",
		);
	});

	it("does not invent a path when the paper folder is missing", () => {
		expect(canonicalPaperPdfPath("")).toBeNull();
		expect(canonicalPaperPdfPath("   ")).toBeNull();
		expect(canonicalPaperPdfPath(".")).toBeNull();
		expect(canonicalPaperPdfPath("..")).toBeNull();
	});
});

describe("isLocalHtmlLink", () => {
	it("accepts vault-relative and absolute local HTML paths", () => {
		expect(isLocalHtmlLink("papers/a/demo.html")).toBe(true);
		expect(isLocalHtmlLink("/Users/me/vault/papers/a/demo.html")).toBe(true);
		expect(isLocalHtmlLink("C:\\vault\\papers\\a\\demo.html")).toBe(true);
		expect(isLocalHtmlLink("papers/a/report.htm#page=2")).toBe(true);
	});

	it("rejects URLs, anchors, protocol-relative and non-HTML paths", () => {
		expect(isLocalHtmlLink("https://example.com/demo.html")).toBe(false);
		expect(isLocalHtmlLink("file:///Users/me/demo.html")).toBe(false);
		expect(isLocalHtmlLink("//example.com/demo.html")).toBe(false);
		expect(isLocalHtmlLink("#demo")).toBe(false);
		expect(isLocalHtmlLink("papers/a/notes.md")).toBe(false);
	});
});

describe("paper tag colors", () => {
	it("edits an existing tag without losing hidden provenance, names, or other colors", () => {
		const tags = [
			{ name: "@zotero:source" },
			{ name: "@arxiv:cs.AI" },
			{ name: "Topic", color: "blue" },
			{ name: "Other", color: "green" },
		];
		const changed = withPaperTagColor(tags, "topic", "red");
		expect(changed).toEqual([
			tags[0],
			tags[1],
			{ name: "Topic", color: "red" },
			tags[3],
		]);
		expect(withPaperTagColor(changed, "Topic", null)[2]).toEqual({
			name: "Topic",
		});
		expect(tags[2].color).toBe("blue");
	});
});

describe("paperTaskLabel", () => {
	afterEach(() => {
		libraryStore.setState({ paperMetaByRelPath: new Map() });
		registerPaperTitleLookup(
			(normalizedPaperRel) =>
				libraryStore.getState().paperMetaByRelPath.get(normalizedPaperRel)
					?.title,
		);
	});

	it("falls back to folder basename when no title lookup is registered", () => {
		clearPaperTitleLookup();
		expect(paperTaskLabel("papers/1706.03762")).toBe("1706.03762");
	});

	it("prefers catalog title over folder id", () => {
		libraryStore.setState({
			paperMetaByRelPath: new Map([
				[
					"papers/1706.03762",
					{
						id: "1706.03762",
						path: "papers/1706.03762",
						title: "Attention Is All You Need",
					} as never,
				],
			]),
		});
		expect(paperTaskLabel("papers/1706.03762")).toBe(
			"Attention Is All You Need",
		);
	});

	it("falls back to folder basename when title is missing", () => {
		expect(paperTaskLabel("papers/1706.03762")).toBe("1706.03762");
	});

	it("ignores papers parent paths", () => {
		expect(paperTaskLabel("papers")).toBeUndefined();
		expect(paperTaskLabel("")).toBeUndefined();
		expect(paperTaskLabel(null)).toBeUndefined();
	});
});

describe("joinTaskDetail", () => {
	it("joins subject and status without duplicating", () => {
		expect(joinTaskDetail("Title", "analyzing")).toBe("Title · analyzing");
		expect(joinTaskDetail("Title", "Title")).toBe("Title");
		expect(joinTaskDetail("Title", "Title · PDF")).toBe("Title · PDF");
		expect(joinTaskDetail(undefined, "Fetching…")).toBe("Fetching…");
	});
});

describe("looksLikeTitleSearchQuery", () => {
	it("treats free-text titles as search queries", () => {
		expect(looksLikeTitleSearchQuery("Attention is all you need")).toBe(true);
		expect(looksLikeTitleSearchQuery("AlphaFold")).toBe(true);
		expect(
			looksLikeTitleSearchQuery("Revisiting 10.1038/nature12373 and friends"),
		).toBe(true);
	});

	it("keeps identifiers and skill sources off the title path", () => {
		expect(looksLikeTitleSearchQuery("1706.03762")).toBe(false);
		expect(looksLikeTitleSearchQuery("10.1038/nature12373")).toBe(false);
		expect(looksLikeTitleSearchQuery("https://arxiv.org/abs/1706.03762")).toBe(
			false,
		);
		expect(looksLikeTitleSearchQuery("1706.03762 10.1038/nature12373")).toBe(
			false,
		);
		expect(
			looksLikeTitleSearchQuery(
				"npx skills add anthropics/skills --skill pptx",
			),
		).toBe(false);
	});
});

describe("paper-reader user prompt language", () => {
	it("asks for Chinese when App locale is zh-CN and targets the paper NOTES.md", () => {
		expect(paperReaderLanguageInstruction("zh-CN")).toMatch(/Chinese/i);
		const prompt = buildPaperReaderUserPrompt("papers/1706.03762", "zh-CN");
		expect(prompt).toMatch(/Chinese/i);
		expect(prompt).toContain("papers/1706.03762/NOTES.md");
	});

	it("asks for English when App locale is en", () => {
		expect(paperReaderLanguageInstruction("en")).toMatch(/English/i);
		const prompt = buildPaperReaderUserPrompt("papers/x", "en");
		expect(prompt).toMatch(/English/i);
		expect(prompt).toContain("NOTES.md");
	});

	it("leaves skill activation syntax to the Host envelope", () => {
		const prompt = buildPaperReaderUserPrompt("papers/x", "en");
		expect(prompt).not.toMatch(
			/\$paper-reader|\/paper-reader|skill:paper-reader/,
		);
		expect(prompt).not.toMatch(
			/Activate and follow|do not wait for a separate/i,
		);
	});

	it("treats other zh* locales as Chinese", () => {
		expect(paperReaderLanguageInstruction("zh")).toMatch(/Chinese/i);
		expect(paperReaderLanguageInstruction("zh-TW")).toMatch(/Chinese/i);
	});
});
