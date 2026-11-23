import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
	rangeCoveringOffsets,
	wordBoundsAt,
} from "@/lib/pdf/layout/word-bounds";

function slice(text: string, offset: number): string {
	const bounds = wordBoundsAt(text, offset);
	return bounds ? text.slice(bounds.start, bounds.end) : "";
}

describe("translation word bounds", () => {
	it("selects an English word, including a caret just after its last letter", () => {
		const text = "The quick brown fox.";
		expect(slice(text, text.indexOf("quick"))).toBe("quick");
		expect(slice(text, text.indexOf("quick") + "quick".length)).toBe("quick");
		expect(slice(text, text.indexOf("."))).toBe("fox");
	});

	it("selects a Chinese word instead of the whole sentence", () => {
		const text = "这是一个中文句子，后面还有内容。";
		expect(slice(text, text.indexOf("一个"))).toBe("一个");
		expect(slice(text, text.indexOf("中文"))).toBe("中文");
		expect(slice(text, 0)).toBe("这");
		expect(slice(text, text.indexOf("一个"))).not.toBe(text);
	});

	it("selects either side of a mixed Chinese and English sentence", () => {
		const text = "使用 Transformer 模型。";
		expect(slice(text, text.indexOf("使用"))).toBe("使用");
		expect(slice(text, text.indexOf("Transformer") + 4)).toBe("Transformer");
		expect(slice(text, text.indexOf("模型"))).toBe("模型");
	});

	it("covers a word that is split across a link", () => {
		const dom = new JSDOM(
			'<p id="sentence">使用 <a href="https://example.test">Transformer</a> 模型</p>',
		);
		const root = dom.window.document.getElementById("sentence");
		if (!root) throw new Error("missing sentence");
		const text = root.textContent ?? "";
		const start = text.indexOf("Transformer");
		const range = rangeCoveringOffsets(
			root as unknown as HTMLElement,
			start,
			start + "Transformer".length,
		);
		expect(range?.toString()).toBe("Transformer");
	});
});
