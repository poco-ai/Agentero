// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { renderedMathFromTarget } from "@/lib/markdown/rendered-math";
import { renderedMathClipboardText } from "@/lib/markdown/rendered-math-copy";

/** Minimal KaTeX DOM: hidden MathML annotation carries the TeX source. */
function katex(tex: string, display = false): string {
	const inner = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord">${tex}</span></span></span>`;
	return display ? `<span class="katex-display">${inner}</span>` : inner;
}

function selectRoot(html: string): Range {
	document.body.innerHTML = `<div data-markdown-copy>${html}</div>`;
	const root = document.querySelector("[data-markdown-copy]");
	if (!root) throw new Error("root missing");
	const range = document.createRange();
	range.selectNodeContents(root);
	return range;
}

describe("renderedMathClipboardText", () => {
	it("keeps inline formula as $…$ inside surrounding text", () => {
		const range = selectRoot(
			`<p>before ${katex("x^{2}+\\frac{a}{b}")} after</p>`,
		);
		expect(renderedMathClipboardText(range)).toBe(
			"before $x^{2}+\\frac{a}{b}$ after",
		);
	});

	it("keeps display formula as a $$ fence", () => {
		const range = selectRoot(
			`<p>前</p>${katex("\\sum_{k=1}^{n}\\alpha_k", true)}<p>后</p>`,
		);
		const text = renderedMathClipboardText(range);
		expect(text).toContain("前");
		expect(text).toContain("后");
		expect(text).toContain("$$\n\\sum_{k=1}^{n}\\alpha_k\n$$");
	});

	it("returns null when the selection has no rendered math", () => {
		const range = selectRoot("<p>plain text only</p>");
		expect(renderedMathClipboardText(range)).toBe(null);
	});

	it("returns null for a collapsed selection", () => {
		selectRoot(`<p>${katex("x")}</p>`);
		const range = document.createRange();
		const text = document.querySelector("p")?.firstChild;
		if (!text) throw new Error("text missing");
		range.setStart(text, 0);
		range.setEnd(text, 0);
		expect(renderedMathClipboardText(range)).toBe(null);
	});

	it("returns null when a katex node has no TeX annotation", () => {
		const range = selectRoot(
			'<span class="katex"><span class="katex-html">x</span></span>',
		);
		expect(renderedMathClipboardText(range)).toBe(null);
	});
});

describe("renderedMathClipboardText with partial selections", () => {
	it("expands a display formula when only its inner glyphs are selected", () => {
		document.body.innerHTML = `<div data-markdown-copy><p>前</p>${katex(
			"\\sum_{k=1}^{n}\\alpha_k",
			true,
		)}<p>后</p></div>`;
		const glyph = document.querySelector(".katex-html .mord");
		if (!glyph) throw new Error("glyph missing");
		const range = document.createRange();
		range.setStart(glyph, 0);
		range.setEnd(glyph, 1);
		const text = renderedMathClipboardText(range);
		expect(text).toContain("$$\n\\sum_{k=1}^{n}\\alpha_k\n$$");
	});

	it("expands an inline formula when the selection ends inside it", () => {
		document.body.innerHTML = `<div data-markdown-copy><p>before ${katex(
			"x^{2}",
		)} after</p></div>`;
		const paragraph = document.querySelector("p");
		const glyph = document.querySelector(".katex-html .mord");
		if (!paragraph || !glyph) throw new Error("dom missing");
		const range = document.createRange();
		range.setStart(paragraph.firstChild ?? paragraph, 0);
		range.setEnd(glyph, 1);
		expect(renderedMathClipboardText(range)).toBe("before $x^{2}$");
	});

	it("replaces the whole formula when the selection is inside the body only", () => {
		document.body.innerHTML = `<div data-markdown-copy>${katex("x", true)}</div>`;
		const body = document.querySelector(".katex-html .mord");
		if (!body) throw new Error("body missing");
		const range = document.createRange();
		range.setStart(body, 0);
		range.setEnd(body, 1);
		const text = renderedMathClipboardText(range);
		expect(text).toBe("$$\nx\n$$");
	});
});

describe("renderedMathClipboardText with real KaTeX output", () => {
	it("keeps a real display formula as a $$ fence", async () => {
		const katex = (await import("katex")).default;
		const html = katex.renderToString("\\sum_{k=1}^{n}\\alpha_k", {
			displayMode: true,
			throwOnError: false,
		});
		document.body.innerHTML = `<div data-markdown-copy><p>前</p>${html}<p>后</p></div>`;
		const root = document.querySelector("[data-markdown-copy]");
		if (!root) throw new Error("root missing");
		const range = document.createRange();
		range.selectNodeContents(root);
		const text = renderedMathClipboardText(range);
		expect(text).toContain("$$\n\\sum_{k=1}^{n}\\alpha_k\n$$");
	});

	it("keeps a real inline formula as $…$", async () => {
		const katex = (await import("katex")).default;
		const html = katex.renderToString("x^{2}", {
			displayMode: false,
			throwOnError: false,
		});
		document.body.innerHTML = `<div data-markdown-copy><p>before ${html} after</p></div>`;
		const root = document.querySelector("[data-markdown-copy]");
		if (!root) throw new Error("root missing");
		const range = document.createRange();
		range.selectNodeContents(root);
		expect(renderedMathClipboardText(range)).toBe("before $x^{2}$ after");
	});
});

describe("renderedMathFromTarget", () => {
	it("returns the raw TeX source from a rendered formula", async () => {
		const katex = (await import("katex")).default;
		document.body.innerHTML = `<div data-markdown-copy><p>${katex.renderToString(
			String.raw`\hat{\sigma}_1`,
			{ displayMode: false, throwOnError: false },
		)}</p></div>`;
		const root = document.querySelector("[data-markdown-copy]");
		const glyph = document.querySelector(".katex-html .mord");
		if (!root || !glyph) throw new Error("rendered formula missing");

		expect(renderedMathFromTarget(glyph, root)?.tex).toBe(
			String.raw`\hat{\sigma}_1`,
		);
	});

	it("ignores targets outside the Markdown surface", async () => {
		const katex = (await import("katex")).default;
		document.body.innerHTML = `<div data-markdown-copy></div><p>${katex.renderToString(
			"x",
			{ throwOnError: false },
		)}</p>`;
		const root = document.querySelector("[data-markdown-copy]");
		const glyph = document.querySelector(".katex-html .mord");
		if (!root || !glyph) throw new Error("rendered formula missing");

		expect(renderedMathFromTarget(glyph, root)).toBe(null);
	});
});
