// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePdfTranslationDisplay } from "@/components/viewer/pdf/hooks/use-pdf-translation-display";

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
