// @vitest-environment happy-dom
import katex from "katex";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownSurface } from "@/components/agent/rendering/markdown-surface";
import { MathCopy } from "@/components/markdown/math-copy";
import i18n from "@/i18n";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import {
	installRenderedMathCopy,
	renderedMathClipboardText,
} from "@/lib/markdown/rendered-math-copy";

vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifySuccess: vi.fn(),
}));

const writeText = vi.fn(async (_text: string) => {});

function renderMath(tex = "x^2", displayMode = false) {
	document.body.innerHTML = renderToStaticMarkup(
		createElement(
			MathCopy,
			null,
			createElement("span", { "data-test-katex": "" }),
		),
	);
	const container = document.querySelector("[data-test-katex]");
	if (!container) throw new Error("missing container");
	container.innerHTML = katex.renderToString(tex, { displayMode });
	const math = document.querySelector<HTMLElement>(".katex");
	if (!math) throw new Error("missing formula");
	return math;
}

function click(target: Element, options: MouseEventInit = {}) {
	return target.dispatchEvent(
		new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			detail: 1,
			...options,
		}),
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	writeText.mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
	document.getSelection()?.removeAllRanges();
	i18n.changeLanguage("en");
	installRenderedMathCopy();
});

afterEach(() => {
	vi.runAllTimers();
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("formula click copy", () => {
	it.each([
		false,
		true,
	])("copies raw multiline TeX and gives local feedback (display=%s)", async (display) => {
		const tex = "\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}";
		const math = renderMath(tex, display);
		click(math.querySelector(".mord") ?? math);
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(tex));
		await vi.waitFor(() =>
			expect(document.querySelector("[role=status]")?.textContent).toBe(
				"Copied",
			),
		);
		expect(document.querySelector("[data-math-copied]")).not.toBeNull();
		expect(notifySuccess).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1200);
		expect(document.querySelector("[data-math-copied]")).toBeNull();
	});

	it("does not copy a selection, a canceled click, a right click, or a drag/scroll ending on a formula", async () => {
		const math = renderMath();
		const range = document.createRange();
		range.selectNodeContents(math);
		document.getSelection()?.addRange(range);
		click(math);
		document.getSelection()?.removeAllRanges();
		math.addEventListener("click", (event) => event.preventDefault(), {
			once: true,
		});
		click(math);
		click(math, { button: 2 });
		for (const canceledBy of [
			"pointermove",
			"pointercancel",
			"dragstart",
			"scroll",
		]) {
			math.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					pointerId: 1,
					clientX: 10,
					clientY: 10,
				}),
			);
			math.dispatchEvent(
				new PointerEvent(canceledBy, {
					bubbles: true,
					pointerId: 1,
					clientX: 30,
					clientY: 10,
				}),
			);
			click(math);
		}
		await Promise.resolve();
		expect(writeText).not.toHaveBeenCalled();
	});

	it("keeps copy chrome out of selection Markdown and works after KaTeX is evicted and re-rendered", async () => {
		const math = renderMath();
		click(math);
		await vi.waitFor(() =>
			expect(document.querySelector("[role=status]")?.textContent).toBe(
				"Copied",
			),
		);
		const range = document.createRange();
		range.selectNodeContents(document.body);
		expect(renderedMathClipboardText(range)).toBe("$x^2$");
		const container = math.parentElement;
		container?.replaceChildren();
		if (!container) throw new Error("missing container");
		container.innerHTML = katex.renderToString("y^3");
		click(container.querySelector(".katex") ?? container);
		await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith("y^3"));
	});

	it("copies the equation editor source from its keyboard accessible button without changing its value", async () => {
		document.body.innerHTML = renderToStaticMarkup(
			createElement(MathCopy, { tex: "a+b" }),
		);
		const button = document.querySelector("button");
		if (!button) throw new Error("missing button");
		expect(button.getAttribute("aria-label")).toBe("Copy LaTeX");
		click(button, { detail: 0 });
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("a+b"));
		expect(
			button.closest<HTMLElement>("[data-math-copy]")?.dataset.mathCopyTex,
		).toBe("a+b");
	});

	it("keeps Markdown selection copy in read-only projections after click feedback", async () => {
		const math = renderMath();
		const wrapper = math.closest("[data-math-copy]");
		if (!wrapper) throw new Error("missing wrapper");
		const inline = document.createElement("div");
		inline.setAttribute("data-slate-inline", "true");
		const placeholder = document.createElement("span");
		placeholder.setAttribute("data-slate-zero-width", "z");
		placeholder.textContent = "\uFEFF";
		inline.append(wrapper, placeholder);
		document.body.replaceChildren("before ", inline, " after");
		document.body.setAttribute("data-markdown-copy", "");
		try {
			click(math);
			await vi.waitFor(() =>
				expect(wrapper.querySelector("[role=status]")?.textContent).toBe(
					"Copied",
				),
			);
			const range = document.createRange();
			range.selectNodeContents(document.body);
			document.getSelection()?.addRange(range);
			const setData = vi.fn();
			const event = new Event("copy", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "clipboardData", { value: { setData } });
			math.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
			expect(setData).toHaveBeenCalledWith("text/plain", "before $x^2$ after");
		} finally {
			document.body.removeAttribute("data-markdown-copy");
		}
	});

	it("ignores missing annotations and shows only an error toast on clipboard failure", async () => {
		const math = renderMath();
		math.querySelector("annotation")?.remove();
		click(math);
		await Promise.resolve();
		expect(writeText).not.toHaveBeenCalled();
		writeText.mockRejectedValueOnce(new Error("denied"));
		click(renderMath());
		await vi.waitFor(() =>
			expect(notifyError).toHaveBeenCalledWith("Could not copy the equation."),
		);
		expect(document.querySelector("[data-math-copied]")).toBeNull();
	});

	it("adds copy controls to Agent inline and display math, with translated feedback", async () => {
		await i18n.changeLanguage("zh-CN");
		document.body.innerHTML = renderToStaticMarkup(
			createElement(MarkdownSurface, null, "Inline $x^2$.\n\n$$\ny^3\n$$"),
		);
		const buttons = document.querySelectorAll(
			"button[aria-label='复制 LaTeX']",
		);
		expect(buttons).toHaveLength(2);
		click(buttons[1], { detail: 0 });
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("y^3"));
		await vi.waitFor(() =>
			expect(
				document.querySelector("[data-math-copied] [role=status]")?.textContent,
			).toBe("已复制"),
		);
	});
});
