import katex from "katex";
import { describe, expect, it } from "vitest";
import { normalizeMarkdownMath } from "@/lib/markdown/math-normalize";

function mathRegions(md: string): string[] {
	return [...md.matchAll(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g)].map((m) => m[0]);
}

function renderAll(md: string): void {
	for (const region of mathRegions(md)) {
		const display = region.startsWith("$$");
		const inner = region.slice(
			display ? 2 : 1,
			region.length - (display ? 2 : 1),
		);
		katex.renderToString(inner, { throwOnError: true, displayMode: display });
	}
}

describe("normalizeMarkdownMath", () => {
	it("expands MathJax-style \\newcommand and strips labels", () => {
		const out = normalizeMarkdownMath(
			"$$\\newcommand{msign}{\\mathop{\\text{msign}}}\\msign(\\boldsymbol{G})\\label{eq:a}$$",
		);
		expect(out).toContain("\\mathop{\\text{msign}}");
		expect(out).not.toContain("\\newcommand");
		expect(out).not.toContain("\\label");
		expect(() => renderAll(out)).not.toThrow();
	});

	it("expands document-wide macros in later equations", () => {
		const src = [
			"$$\\newcommand{msign}{\\mathop{\\text{msign}}}\\msign(\\boldsymbol{G})$$",
			"",
			"later $$\\boldsymbol{W}^{\\top}\\msign(\\boldsymbol{G}) = \\boldsymbol{0}$$",
		].join("\n");
		const out = normalizeMarkdownMath(src);
		const regions = mathRegions(out);
		expect(regions).toHaveLength(2);
		expect(regions[1]).toContain("\\mathop{\\text{msign}}");
		expect(() => renderAll(out)).not.toThrow();
	});

	it("tolerates redefinition of KaTeX builtins like argmin", () => {
		const src =
			"$$\\newcommand{\\argmin}{\\mathop{\\text{argmin}}} \\boldsymbol{p} = \\argmin_{\\boldsymbol{q}} L(\\boldsymbol{p}, \\boldsymbol{q})$$";
		const out = normalizeMarkdownMath(src);
		expect(out).toContain("\\mathop{\\text{argmin}}_{\\boldsymbol{q}}");
		expect(() => renderAll(out)).not.toThrow();
	});

	it("expands macros used across align cell boundaries", () => {
		const src =
			"$$\\begin{align}\\newcommand{diag}{\\mathop{\\text{diag}}} a & = \\diag(x) \\\\ b & = \\diag(y)\\end{align}$$";
		const out = normalizeMarkdownMath(src);
		expect(() => renderAll(out)).not.toThrow();
	});

	it("repairs htmd-escaped display math from older caches", () => {
		const src =
			"$$\\\\newcommand{\\\\rs}{\\\\rule\\[-1.2ex\\]{0pt}{3.5ex}} \\\\rs\\\\text{ok} x\\_1$$";
		const out = normalizeMarkdownMath(src);
		expect(out).toContain("\\rule[-1.2ex]{0pt}{3.5ex}");
		expect(out).toContain("\\text{ok}");
		expect(out).toContain("x_1");
		expect(() => renderAll(out)).not.toThrow();
	});

	it("strips \\require and degrades \\cancel to its argument", () => {
		const src =
			"$$\\require{cancel}\\cancel{S(q_i)} = \\cancel{S(q_i)} + q_i$$";
		const out = normalizeMarkdownMath(src);
		expect(out).not.toContain("\\require");
		expect(out).not.toContain("\\cancel");
		expect(out).toContain("S(q_i)");
		expect(() => renderAll(out)).not.toThrow();
	});

	it("resolves \\eqref to display equation numbers", () => {
		const src =
			"$$a = b\\label{eq:a}$$\n\ntext $$c = d\\label{eq:b}$$\n\nsee $\\eqref{eq:a}$ and $\\ref{eq:b}$";
		const out = normalizeMarkdownMath(src);
		expect(out).toContain("$(1)$");
		expect(out).toContain("$(2)$");
		expect(out).not.toContain("\\eqref");
		expect(() => renderAll(out)).not.toThrow();
	});

	it("renders blog-style equation sequences without KaTeX errors", () => {
		const src = [
			"约束简化成",
			"$$\\newcommand{tr}{\\mathop{\\text{tr}}}\\max_{\\boldsymbol{\\Phi}} \\tr(\\boldsymbol{G}^{\\top}\\boldsymbol{\\Phi}) \\qquad \\text{s.t.}\\qquad \\Vert\\boldsymbol{\\Phi}\\Vert_2 \\leq 1$$",
			"此前我们的求解结果是",
			"$$\\boldsymbol{\\Phi} = \\newcommand{msign}{\\mathop{\\text{msign}}}\\msign(\\boldsymbol{G} + \\boldsymbol{W}\\boldsymbol{X})\\label{eq:Phi}$$",
			"其中$\\boldsymbol{X}$是对称矩阵，满足",
			"$$\\boldsymbol{W}^{\\top}\\msign(\\boldsymbol{G} + \\boldsymbol{W}\\boldsymbol{X})+\\msign(\\boldsymbol{G} + \\boldsymbol{W}\\boldsymbol{X})^{\\top}\\boldsymbol{W} = \\boldsymbol{0}\\label{eq:X}$$",
			"即式$\\eqref{eq:Phi}$与式$\\eqref{eq:X}$。",
		].join("\n");
		const out = normalizeMarkdownMath(src);
		expect(out).toContain(
			"\\mathop{\\text{msign}}(\\boldsymbol{G} + \\boldsymbol{W}\\boldsymbol{X})",
		);
		expect(() => renderAll(out)).not.toThrow();
	});

	it("puts display fences on their own lines so align renders", () => {
		const out = normalizeMarkdownMath(
			"$$ \\begin{align}1) &\\quad a = b \\\\[5pt] 2) &\\quad c = d\\end{align} $$",
		);
		expect(out).toContain("$$\n\\begin{align}");
		expect(out).toContain("\\end{align}\n$$");
		expect(() => renderAll(out)).not.toThrow();
	});

	it("keeps mid-sentence display math inline so blockquotes survive", () => {
		const src =
			"> 使得 $$ \\left\\Vert\\begin{bmatrix}\\boldsymbol{A} \\\\ \\boldsymbol{B}\\end{bmatrix}\\right\\Vert_2 \\leq 1 $$";
		const out = normalizeMarkdownMath(src);
		expect(out).toBe(
			"> 使得 $$\\left\\Vert\\begin{bmatrix}\\boldsymbol{A} \\\\ \\boldsymbol{B}\\end{bmatrix}\\right\\Vert_2 \\leq 1$$",
		);
		// Single-line $$…$$ parses as inline math in remark-math.
		const inner = out.slice(out.indexOf("$$") + 2, out.lastIndexOf("$$"));
		katex.renderToString(inner, { throwOnError: true, displayMode: false });
	});

	it("re-fences block-positioned display math inside blockquotes with markers", () => {
		const src = "> $$\n> \\begin{align}a & = b \\\\ c & = d\\end{align}\n> $$";
		const out = normalizeMarkdownMath(src);
		expect(out).toBe(
			"> $$\n> \\begin{align}a & = b \\\\ c & = d\\end{align}\n> $$",
		);
		expect(() => renderAll(out)).not.toThrow();
	});

	it("leaves plain math and bare commands working", () => {
		const out = normalizeMarkdownMath(
			"value $\\pi_\\theta$ and $$x^2$$ plain 42",
		);
		expect(out).toContain("$\\pi_\\theta$");
		expect(out).toContain("$$x^2$$");
		expect(out).toContain("plain 42");
		expect(() => renderAll(out)).not.toThrow();
	});
});
