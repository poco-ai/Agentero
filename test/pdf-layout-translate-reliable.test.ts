import { describe, expect, it } from "vitest";
import {
	isLayoutTranslateItemPainted,
	LAYOUT_TRANSLATE_MAX_CHARS,
	splitLongLayoutTranslateSource,
} from "@/lib/pdf/layout/layout-translate-reliable";

describe("PDF layout translation reliability", () => {
	it("keeps oversized source instead of truncating it", () => {
		const sentences = Array.from(
			{ length: 80 },
			(_, index) =>
				`Sentence ${index} carries source text that must survive splitting.`,
		);
		const source = sentences.join(" ");
		const chunks = splitLongLayoutTranslateSource(source);

		expect(chunks.length).toBeGreaterThan(1);
		expect(
			chunks.every((chunk) => chunk.length <= LAYOUT_TRANSLATE_MAX_CHARS),
		).toBe(true);
		expect(chunks.join(" ")).toBe(source);
	});

	it("hard-splits unbroken text without losing characters", () => {
		const source = "x".repeat(LAYOUT_TRANSLATE_MAX_CHARS * 2 + 137);
		const chunks = splitLongLayoutTranslateSource(source);

		expect(chunks.map((chunk) => chunk.length)).toEqual([
			LAYOUT_TRANSLATE_MAX_CHARS,
			LAYOUT_TRANSLATE_MAX_CHARS,
			137,
		]);
		expect(chunks.join("")).toBe(source);
	});
});

describe("isLayoutTranslateItemPainted", () => {
	it("paints completed or retained translations and keeps source visible while waiting", () => {
		expect(
			isLayoutTranslateItemPainted({ status: "done", translated: "已翻译" }),
		).toBe(true);
		expect(isLayoutTranslateItemPainted({ status: "running" })).toBe(false);
		expect(
			isLayoutTranslateItemPainted({ status: "running", translated: "旧译文" }),
		).toBe(true);
	});

	it("returns true for error items only when partial translation exists", () => {
		expect(
			isLayoutTranslateItemPainted({ status: "error", translated: "部分译文" }),
		).toBe(true);
		expect(isLayoutTranslateItemPainted({ status: "error" })).toBe(false);
		expect(
			isLayoutTranslateItemPainted({ status: "error", translated: "" }),
		).toBe(false);
	});

	it("returns false for pending or skipped items", () => {
		expect(isLayoutTranslateItemPainted({ status: "pending" })).toBe(false);
		expect(isLayoutTranslateItemPainted({ status: "skipped" })).toBe(false);
	});
});
