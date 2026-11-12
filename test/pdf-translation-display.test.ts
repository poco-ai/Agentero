// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { usePdfTranslationDisplay } from "@/components/viewer/pdf/hooks/use-pdf-translation-display";
import { pickPdfSearchDocumentId } from "@/lib/pdf/search-target";

it("switches the viewer search back to source while cached translations remain loaded", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// Exercise the actual viewer guard alongside the real display hook without
	// mounting the PDF engine. Cached page state survives the toolbar toggle.
	const source = ts.createSourceFile(
		"pdf-viewer.tsx",
		readFileSync("src/components/viewer/pdf/pdf-viewer.tsx", "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	let guard: string | undefined;
	function visit(node: ts.Node): void {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText(source) === "translationShown"
		) {
			guard = node.initializer?.getText(source);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	if (!guard) throw new Error("viewer translation visibility guard missing");
	const host = document.createElement("div");
	const root = createRoot(host);
	const cachedPages = new Map([[0, { active: true, running: false }]]);
	function View() {
		const display = usePdfTranslationDisplay({
			docId: "source",
			hasTranslations: true,
			active: true,
			busy: false,
			restore: vi.fn(),
			closeSelection: vi.fn(),
		});
		const visible = runInNewContext(`(${guard})`, {
			translationPane: false,
			dualPaneTranslate: false,
			translationsVisible: display.visible,
			layoutTranslatePageStateByPage: cachedPages,
		});
		return createElement(
			"button",
			{ type: "button", onClick: display.toggle },
			pickPdfSearchDocumentId({
				sourceDocumentId: "source",
				translatedDocumentId: "translated",
				translationVisible: visible,
			}),
		);
	}
	try {
		await act(() => root.render(createElement(View)));
		expect(host.textContent).toBe("translated");
		await act(() => host.querySelector("button")?.click());
		expect(cachedPages.size).toBe(1);
		expect(host.textContent).toBe("source");
		await act(() => host.querySelector("button")?.click());
		expect(host.textContent).toBe("translated");
	} finally {
		await act(() => root.unmount());
	}
});

it("restores the PDF cache and switches PDF and reader translations together without translating again", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	const root = createRoot(host);
	const restore = vi.fn();
	const close = vi.fn();
	function View({ active = false, docId = "paper" }) {
		const display = usePdfTranslationDisplay({
			docId,
			hasTranslations: true,
			active,
			busy: false,
			restore,
			closeSelection: close,
		});
		return createElement(
			"div",
			null,
			createElement(
				"button",
				{ type: "button", onClick: display.toggle },
				"translate",
			),
			createElement("div", {
				"data-pdf-translation": display.visible && active,
			}),
			createElement("div", { "data-reader-translation": display.visible }),
		);
	}
	try {
		await act(() => root.render(createElement(View)));
		expect(restore).toHaveBeenCalledOnce();
		await act(() => root.render(createElement(View, { active: true })));
		const shown = () =>
			[
				...host.querySelectorAll(
					"[data-pdf-translation], [data-reader-translation]",
				),
			].map((el) =>
				el.getAttribute(
					el.hasAttribute("data-pdf-translation")
						? "data-pdf-translation"
						: "data-reader-translation",
				),
			);
		expect(shown()).toEqual(["true", "true"]);
		await act(() => host.querySelector("button")?.click());
		expect(shown()).toEqual(["false", "false"]);
		await act(() => host.querySelector("button")?.click());
		expect(shown()).toEqual(["true", "true"]);
		expect(restore).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledTimes(2);
		await act(() => host.querySelector("button")?.click());
		await act(() =>
			root.render(createElement(View, { active: true, docId: "other" })),
		);
		expect(shown()).toEqual(["true", "true"]);
	} finally {
		await act(() => root.unmount());
	}
});

afterEach(() => vi.unstubAllGlobals());
