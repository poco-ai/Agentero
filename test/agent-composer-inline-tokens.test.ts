import { describe, expect, it } from "vitest";
import {
	appendMissingInlineTokens,
	appendSelectionTokens,
	encodeCommandToken,
	encodeMentionToken,
	encodeSelectionToken,
	encodeSkillToken,
	encodeVisualToken,
	extractMentionPaths,
	extractSelectionTokens,
	extractSkillIds,
	extractVisualIds,
	hasTranscriptChips,
	inlineMarkupToPlain,
	insertTokensAt,
	parseInlineTokenParts,
	plainTriggerSuffix,
	referenceInsertionOffset,
	removeVisualToken,
	replaceSelectionToken,
	replaceTrailingTriggerWithToken,
	retainTranscriptChips,
	stripInlineTokens,
	transcriptMarkup,
} from "@/lib/agent/composer-inline-tokens";
import type { SelectionContext } from "@/lib/agent/selection-store";

describe("composer inline tokens", () => {
	it("round-trips mention and skill markers", () => {
		const path = "papers/foo/NOTES.md";
		const skill = "paper-reader";
		const text = `see ${encodeMentionToken(path)} and ${encodeSkillToken(skill)} please`;
		expect(extractMentionPaths(text)).toEqual([path]);
		expect(extractSkillIds(text)).toEqual([skill]);
		expect(stripInlineTokens(text)).toBe("see and please");
	});

	it("keeps mention chips readable after send", () => {
		const path = "notes/论文关系图.md";
		const text = `帮我梳理一下 ${encodeMentionToken(path)}`;
		expect(hasTranscriptChips(text)).toBe(true);
		expect(transcriptMarkup(text)).toBe(text);
		expect(transcriptMarkup("只要文字")).toBeUndefined();
		expect(inlineMarkupToPlain(text)).toBe("帮我梳理一下 @论文关系图.md");
		expect(stripInlineTokens(text)).toBe("帮我梳理一下");
	});

	it("keeps chip positions when an edit does not change the sentence", () => {
		const path = "notes/a.md";
		const text = `see ${encodeMentionToken(path)} please`;
		expect(retainTranscriptChips("see please", text)).toBe(text);
		expect(retainTranscriptChips("see this please", text)).toBe(
			`see this please ${encodeMentionToken(path)}`,
		);
	});

	it("expands command markers to /name on send", () => {
		const text = `run ${encodeCommandToken("summarize")} now`;
		expect(stripInlineTokens(text)).toBe("run /summarize now");
	});

	it("encodes odd path characters", () => {
		const path = "notes/a b/文件.md";
		const token = encodeMentionToken(path);
		expect(extractMentionPaths(`x ${token} y`)).toEqual([path]);
	});

	it("replaces a trailing @ trigger with a mention token", () => {
		const next = replaceTrailingTriggerWithToken(
			"hello @no",
			"mention",
			encodeMentionToken("a.md"),
		);
		expect(next).toBe(`hello ${encodeMentionToken("a.md")} `);
		expect(extractMentionPaths(next)).toEqual(["a.md"]);
	});

	it("replaces a trailing $ trigger with a skill token", () => {
		const next = replaceTrailingTriggerWithToken(
			"run $pap",
			"skill",
			encodeSkillToken("paper-reader"),
		);
		expect(next).toBe(`run ${encodeSkillToken("paper-reader")} `);
	});

	it("replaces a trailing / trigger with a command token", () => {
		const next = replaceTrailingTriggerWithToken(
			"do /sum",
			"command",
			encodeCommandToken("summarize"),
		);
		expect(next).toBe(`do ${encodeCommandToken("summarize")} `);
		expect(stripInlineTokens(next)).toBe("do /summarize");
	});

	it("appends missing tokens for legacy drafts", () => {
		const next = appendMissingInlineTokens(
			"hello",
			["a.md", "b.md"],
			["skill-a"],
		);
		expect(extractMentionPaths(next)).toEqual(["a.md", "b.md"]);
		expect(extractSkillIds(next)).toEqual(["skill-a"]);
		expect(next.startsWith("hello")).toBe(true);
	});

	it("does not duplicate tokens already present", () => {
		const token = encodeMentionToken("a.md");
		const next = appendMissingInlineTokens(`x ${token} `, ["a.md"], []);
		expect(next).toBe(`x ${token} `);
	});

	it("masks markers in the trigger suffix so $ inside tokens is inert", () => {
		const text = `x ${encodeSkillToken("ab")} $c`;
		expect(plainTriggerSuffix(text).endsWith(" $c")).toBe(true);
		expect(plainTriggerSuffix(text)).not.toContain("{{");
	});

	it("parses parts for rendering", () => {
		const parts = parseInlineTokenParts(
			`A ${encodeMentionToken("p.md")} B ${encodeSkillToken("s1")} C ${encodeCommandToken("cmd")}`,
		);
		expect(parts).toEqual([
			{ type: "text", value: "A " },
			{ type: "mention", path: "p.md" },
			{ type: "text", value: " B " },
			{ type: "skill", skillId: "s1" },
			{ type: "text", value: " C " },
			{ type: "command", name: "cmd" },
		]);
	});

	describe("selection tokens", () => {
		const selection: SelectionContext = {
			id: "sel-1",
			text: "attention is all you need",
			sourcePath: "papers/transformer",
			origin: "pdf",
			page: 3,
			pinned: false,
		};

		it("round-trips selection markers", () => {
			const token = encodeSelectionToken(selection);
			const text = `see ${token} please`;
			expect(extractSelectionTokens(text)).toEqual([selection]);
			expect(stripInlineTokens(text)).toBe("see please");
		});

		it("preserves PDF anchor geometry", () => {
			const withGeometry: SelectionContext = {
				...selection,
				rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
				paperAbsPath: "/vault/papers/transformer",
			};
			const token = encodeSelectionToken(withGeometry);
			const recovered = extractSelectionTokens(token);
			expect(recovered).toEqual([withGeometry]);
		});

		it("round-trips selection text with Unicode characters", () => {
			const unicode: SelectionContext = {
				...selection,
				text: "注意力机制 你好 🌍",
				sourcePath: "papers/注意力机制",
			};
			const token = encodeSelectionToken(unicode);
			const recovered = extractSelectionTokens(`x ${token} y`);
			expect(recovered).toEqual([unicode]);
		});

		it("parses selection parts for rendering", () => {
			const token = encodeSelectionToken(selection);
			const parts = parseInlineTokenParts(`A ${token} B`);
			expect(parts).toEqual([
				{ type: "text", value: "A " },
				{ type: "selection", selection },
				{ type: "text", value: " B" },
			]);
		});

		it("masks selection markers in trigger suffix", () => {
			const text = `x ${encodeSelectionToken(selection)} $c`;
			expect(plainTriggerSuffix(text).endsWith(" $c")).toBe(true);
			expect(plainTriggerSuffix(text)).not.toContain("{{");
		});

		it("treats a selection token as a trigger boundary", () => {
			const text = `${encodeSelectionToken(selection)}@notes`;
			expect(plainTriggerSuffix(text)).toMatch(/(^|\s|\uFFFC)@([^\s]*)$/);
		});

		it("inserts a quote at the caret, before a trailing break", () => {
			const token = encodeSelectionToken(selection);
			const draft = "这个是个\n";
			const next = insertTokensAt(draft, 4, token);
			expect(next.text.startsWith(`这个是个 ${token}`)).toBe(true);
			expect(next.text.endsWith("\n")).toBe(true);
			expect(next.text.indexOf(token)).toBeLessThan(next.text.indexOf("\n"));
			expect(next.caret).toBe(`这个是个 ${token}`.length);
		});

		it("inserts a quote in the middle of a sentence", () => {
			const token = encodeSelectionToken(selection);
			const next = insertTokensAt("对于这段", 2, token);
			expect(next.text).toBe(`对于 ${token} 这段`);
			expect(next.caret).toBe(`对于 ${token} `.length);
		});

		it("keeps an unknown caret off a lone trailing break", () => {
			const token = encodeSelectionToken(selection);
			expect(referenceInsertionOffset("这个是个\n", null)).toBe(4);
			expect(referenceInsertionOffset("这个是个\n", 5)).toBe(5);
			expect(referenceInsertionOffset("这个是个", null)).toBeNull();
			const next = insertTokensAt(
				"这个是个\n",
				referenceInsertionOffset("这个是个\n", null),
				token,
			);
			expect(next.text.indexOf(token)).toBeLessThan(next.text.indexOf("\n"));
		});

		it("round-trips visual markers and strips them on send", () => {
			const token = encodeVisualToken("mark/1");
			expect(token).toBe("{{vis:mark%2F1}}");
			expect(extractVisualIds(`看 ${token} 这里 ${token}`)).toEqual(["mark/1"]);
			const parts = parseInlineTokenParts(`看 ${token}`);
			expect(parts).toEqual([
				{ type: "text", value: "看 " },
				{ type: "visual", id: "mark/1" },
			]);
			expect(stripInlineTokens(`看 ${token} 这里`)).toBe("看 这里");
			expect(removeVisualToken(`看 ${token} 这里`, "mark/1")).toBe("看 这里");
		});

		it("appends new quotes after prose and leaves earlier quotes in place", () => {
			const first = {
				...selection,
				id: "one",
				text: "first block",
			};
			const second = {
				...selection,
				id: "two",
				text: "second block",
			};
			const draft = `对于 ${encodeSelectionToken(first)} 以及`;
			const next = appendSelectionTokens(draft, [first, second]);
			expect(extractSelectionTokens(next).map((item) => item.id)).toEqual([
				"one",
				"two",
			]);
			expect(next.startsWith("对于 ")).toBe(true);
			expect(next.includes(" 以及 ")).toBe(true);
			expect(appendSelectionTokens("", [second])).toBe(
				encodeSelectionToken(second),
			);
			expect(appendSelectionTokens("对于 ", [second]).startsWith("对于 ")).toBe(
				true,
			);
		});

		it("rewrites one selection marker in place", () => {
			const token = encodeSelectionToken(selection);
			const draft = `看 ${token} 这里`;
			expect(replaceSelectionToken(draft, selection)).toBe(draft);
			const updated = {
				...selection,
				text: "new quote",
				comment: "note",
			};
			const next = replaceSelectionToken(draft, updated);
			expect(extractSelectionTokens(next)).toEqual([updated]);
			expect(next.startsWith("看 ")).toBe(true);
			expect(next.endsWith(" 这里")).toBe(true);
			expect(replaceSelectionToken(draft, { ...selection, id: "other" })).toBe(
				draft,
			);
		});

		it("replaces a trigger that sits against a selection token", () => {
			const token = encodeSelectionToken(selection);
			const next = replaceTrailingTriggerWithToken(
				`${token}@notes`,
				"mention",
				encodeMentionToken("notes/a.md"),
			);
			expect(next.startsWith(token)).toBe(true);
			expect(next).not.toContain("@notes");
			expect(extractMentionPaths(next)).toEqual(["notes/a.md"]);
		});
	});
});
