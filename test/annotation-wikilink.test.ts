import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import { describe, expect, it } from "vitest";

import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { WikiLinkPlugin } from "@/components/editor/plugins/wikilink-plugin";
import {
	annotationWikilinkAlias,
	annotationWikilinkMarkdown,
	truncateAnnotationPreview,
	wikiTargetForPaper,
} from "@/lib/pdf/annotation-ref";
import {
	extractWikilinks,
	formatWikiLinkBody,
	isValidAnnotationId,
	parseWikiFragment,
	resolveDemoWikiReference,
	resolveWikiTarget,
	splitAnnotationSugar,
} from "@/lib/wiki";
import {
	parseWikiLinkMarkdown,
	wikiLinkRules,
	wikiLinkToMarkdown,
} from "@/lib/wiki/wikilink-model";
import { parseWikiCompletionQuery } from "@/lib/wiki-completion";

describe("annotation wikilink parse", () => {
	it("accepts sugar target@id and #@id fragment", () => {
		const links = extractWikilinks(
			"See [[NOTES@abc-123|q]] and ![[paper#@def456]].\n",
		);
		expect(links).toHaveLength(2);
		expect(links[0]).toMatchObject({
			targetRaw: "NOTES",
			fragment: { kind: "annotation", id: "abc-123" },
			alias: "q",
		});
		expect(links[1]).toMatchObject({
			targetRaw: "paper",
			embed: true,
			fragment: { kind: "annotation", id: "def456" },
		});
	});

	it("accepts same-note [[@id]] and nanoid underscore ids", () => {
		const links = extractWikilinks(
			"[[@TGDf_eZGV4]] and [[../NOTES.md@x_y-1]] and [[paper.pdf@ab_c]] and ![[papers/foo/NOTES@TGDf\\_eZGV4|alias]].\n",
		);
		expect(links).toHaveLength(4);
		expect(links[0]).toMatchObject({
			targetRaw: "",
			fragment: { kind: "annotation", id: "TGDf_eZGV4" },
		});
		expect(links[1]).toMatchObject({
			targetRaw: "../NOTES.md",
			fragment: { kind: "annotation", id: "x_y-1" },
		});
		expect(links[2]).toMatchObject({
			targetRaw: "paper.pdf",
			fragment: { kind: "annotation", id: "ab_c" },
		});
		// Escaped underscore must not collapse the token into a missing file path.
		expect(links[3]).toMatchObject({
			targetRaw: "papers/foo/NOTES",
			embed: true,
			fragment: { kind: "annotation", id: "TGDf_eZGV4" },
			alias: "alias",
		});
	});

	it("does not treat invalid sugar as annotation", () => {
		const links = extractWikilinks("[[keep@not valid]]\n");
		expect(links[0]?.targetRaw).toBe("keep@not valid");
		expect(links[0]?.fragment).toBeUndefined();
	});

	it("round-trips sugar through the editor model", () => {
		const md = "![[Attention@uuid-1|note]]";
		const node = parseWikiLinkMarkdown(md);
		expect(node).toMatchObject({
			value: "Attention",
			heading: "@uuid-1",
			alias: "note",
			embed: true,
		});
		if (!node) throw new Error("Expected an embedded wikilink node");
		expect(wikiLinkToMarkdown(node)).toBe(md);
		const sameNote = parseWikiLinkMarkdown("[[@TGDf_eZGV4]]");
		expect(sameNote).toMatchObject({
			value: "",
			heading: "@TGDf_eZGV4",
		});
		if (!sameNote) throw new Error("Expected a same-note wikilink node");
		expect(wikiLinkToMarkdown(sameNote)).toBe("[[@TGDf_eZGV4]]");
	});

	it("unescapes path underscores corrupted by mdast state.safe", () => {
		const path = "papers/10_1007_s11390-025-5140-6/NOTES";
		const escaped =
			"![[papers/10\\_1007\\_s11390-025-5140-6/NOTES@mh8SPQgbMG|Parfxxx]]";
		const node = parseWikiLinkMarkdown(escaped);
		expect(node).toMatchObject({
			value: path,
			heading: "@mh8SPQgbMG",
			alias: "Parfxxx",
			embed: true,
		});
		if (!node) throw new Error("Expected an annotation wikilink node");
		expect(wikiLinkToMarkdown(node)).toBe(`![[${path}@mh8SPQgbMG|Parfxxx]]`);
		expect(
			splitAnnotationSugar("papers/10\\_1007\\_s11390/NOTES@ab_c"),
		).toEqual({
			target: "papers/10_1007_s11390/NOTES",
			id: "ab_c",
		});
		// Stem-only "NOTES" would be ambiguous; full path must resolve uniquely.
		const files = [
			"papers/10_1007_s11390-025-5140-6/NOTES.md",
			"papers/other-paper/NOTES.md",
		];
		expect(resolveWikiTarget(path, files)).toBe(
			"papers/10_1007_s11390-025-5140-6/NOTES.md",
		);
		expect(
			resolveWikiTarget("papers/10\\_1007\\_s11390-025-5140-6/NOTES", files),
		).toBeNull();
	});

	it("serializes annotation embeds without escaping vault path underscores", () => {
		const path = "papers/10_1007_s11390-025-5140-6/NOTES";
		const md = `![[${path}@mh8SPQgbMG|Parfxxx]]`;
		const node = parseWikiLinkMarkdown(md);
		if (!node) throw new Error("expected parsed embed");
		expect(wikiLinkRules.wikiLink.serialize(node)).toEqual({
			type: "embed",
			value: `${path}@mh8SPQgbMG`,
			data: { alias: "Parfxxx" },
		});

		const ParagraphPlugin = createSlatePlugin({
			key: KEYS.p,
			node: { isElement: true },
		});
		const editor = createSlateEditor({
			plugins: [ParagraphPlugin, WikiLinkPlugin, ...MarkdownKit],
			value: [{ type: "p", children: [node] }],
		});
		const serialized = editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(serialized).not.toContain("\\_");
		expect(serialized.trimEnd()).toBe(md);

		// Re-open path: deserialize → serialize must keep literal underscores.
		const reopened = createSlateEditor({
			plugins: [ParagraphPlugin, WikiLinkPlugin, ...MarkdownKit],
			value: (ed) => ed.getApi(MarkdownPlugin).markdown.deserialize(serialized),
		});
		const again = reopened.getApi(MarkdownPlugin).markdown.serialize();
		expect(again.trimEnd()).toBe(md);
	});

	it("formats annotation bodies with preferred sugar", () => {
		expect(
			formatWikiLinkBody("paper", { kind: "annotation", id: "x1" }, "alias"),
		).toBe("paper@x1|alias");
		expect(formatWikiLinkBody("", { kind: "annotation", id: "x1" })).toBe(
			"@x1",
		);
		expect(
			annotationWikilinkMarkdown({ target: "p", id: "x", embed: true }),
		).toBe("![[p@x]]");
		expect(
			annotationWikilinkMarkdown({
				target: "papers/foo/NOTES",
				id: "TGDf_eZGV4",
				alias: "Towards Long Horizon Agent",
			}),
		).toBe("[[papers/foo/NOTES@TGDf_eZGV4|Towards Long Horizon Agent]]");
		expect(parseWikiFragment("@ab-c")).toEqual({
			kind: "annotation",
			id: "ab-c",
		});
		expect(splitAnnotationSugar("a@b")).toEqual({ target: "a", id: "b" });
		expect(splitAnnotationSugar("@TGDf_eZGV4")).toEqual({
			target: "",
			id: "TGDf_eZGV4",
		});
		expect(isValidAnnotationId("TGDf_eZGV4")).toBe(true);
		expect(isValidAnnotationId("not id")).toBe(false);
	});

	it("demo resolver accepts annotation fragments when the target exists", () => {
		const resolved = resolveDemoWikiReference(
			"notes/Source.md",
			"Target@abc-1",
			[{ path: "notes/Target.md", content: "# Hi\n" }],
		);
		expect(resolved.status).toBe("resolved");
		expect(resolved.fragment).toEqual({ kind: "annotation", id: "abc-1" });
		expect(resolved.targetPath).toBe("notes/Target.md");
	});

	it("derives a resolvable wiki target from paper paths (not display title)", () => {
		expect(
			wikiTargetForPaper("/v/papers/1706.03762", "papers/1706.03762"),
		).toBe("papers/1706.03762/NOTES");
		expect(
			wikiTargetForPaper(
				"/v/papers/1706.03762/NOTES.md",
				"papers/1706.03762/NOTES.md",
			),
		).toBe("papers/1706.03762/NOTES");
		expect(
			wikiTargetForPaper("/v/papers/foo/paper.pdf", "papers/foo/paper.pdf"),
		).toBe("papers/foo/paper.pdf");
	});

	it("completion grammar treats @ as annotation mode", () => {
		expect(parseWikiCompletionQuery("@")).toEqual({
			kind: "annotation",
			target: "",
			query: "",
		});
		expect(parseWikiCompletionQuery("@TG")).toEqual({
			kind: "annotation",
			target: "",
			query: "TG",
		});
		expect(parseWikiCompletionQuery("NOTES@")).toEqual({
			kind: "annotation",
			target: "NOTES",
			query: "",
		});
		expect(parseWikiCompletionQuery("paper.pdf@ab")).toEqual({
			kind: "annotation",
			target: "paper.pdf",
			query: "ab",
		});
		expect(parseWikiCompletionQuery("#@x")).toEqual({
			kind: "annotation",
			target: "",
			query: "x",
		});
	});

	it("builds title·snippet aliases with truncation", () => {
		expect(truncateAnnotationPreview("hello world", 20)).toBe("hello world");
		expect(truncateAnnotationPreview("a".repeat(50), 10)).toBe(
			`${"a".repeat(9)}…`,
		);
		expect(
			annotationWikilinkAlias(
				"Towards Long Horizon Agent",
				"这是一段很长的批注内容需要截断显示",
				12,
			),
		).toBe(
			`Towards Long Horizon Agent·${truncateAnnotationPreview("这是一段很长的批注内容需要截断显示", 12)}`,
		);
		expect(
			annotationWikilinkMarkdown({
				target: "papers/Towards-Long-Horizon-Agent/NOTES",
				id: "TGDf_eZGV4",
				alias: annotationWikilinkAlias(
					"Towards Long Horizon Agent",
					"short note",
				),
			}),
		).toBe(
			"[[papers/Towards-Long-Horizon-Agent/NOTES@TGDf_eZGV4|Towards Long Horizon Agent·short note]]",
		);
	});
});
