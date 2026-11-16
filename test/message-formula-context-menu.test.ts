// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MessageContent } from "@/components/agent/message";
import { copyTextToClipboard } from "@/lib/core/clipboard";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/core/clipboard", () => ({
	copyTextToClipboard: vi.fn(async () => true),
}));

const KATEX_HTML = String.raw`<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">\hat{\sigma}_1</annotation></semantics></math></span><span class="katex-html"><span class="mord">σ</span></span></span>`;

it("copies raw LaTeX from the formula context menu", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(() =>
			root.render(
				createElement(
					MessageContent,
					null,
					createElement("p", {
						// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX fixture
						dangerouslySetInnerHTML: { __html: KATEX_HTML },
					}),
				),
			),
		);
		const glyph = host.querySelector(".katex-html .mord");
		if (!glyph) throw new Error("formula fixture missing");
		const contextMenu = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: 120,
			clientY: 80,
		});
		await act(() => glyph.dispatchEvent(contextMenu));

		expect(contextMenu.defaultPrevented).toBe(true);
		const copy = Array.from(
			document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		).find((element) => element.textContent === "formula.copyLatex");
		if (!copy) throw new Error("formula context menu missing");
		await act(() => copy.click());

		expect(copyTextToClipboard).toHaveBeenCalledWith(
			String.raw`\hat{\sigma}_1`,
			{
				successMessage: "formula.copied",
				errorMessage: "formula.copyFailed",
			},
		);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
