// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidBlock } from "@/components/markdown/mermaid-diagram";
import { copyTextToClipboard } from "@/lib/core/clipboard";

const { getMermaid, render } = vi.hoisted(() => {
	const render = vi.fn(async () => ({
		svg: '<svg style="max-width: 400px;" viewBox="0 0 400 200"></svg>',
	}));
	return { getMermaid: vi.fn(() => ({ render })), render };
});

vi.mock("@streamdown/mermaid", () => ({ mermaid: { getMermaid } }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("next-themes", () => ({
	useTheme: () => ({ resolvedTheme: "dark" }),
}));
vi.mock("@/hooks/use-highlighted-code", () => ({
	useHighlightedCode: (code: string) => code.split("\n"),
}));
vi.mock("@/lib/core/clipboard", () => ({
	copyTextToClipboard: vi.fn(async () => true),
}));

const SOURCE = "graph LR\n  A[Start] --> B[End]";

function renderBlock() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	return { host, root };
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(private readonly callback: IntersectionObserverCallback) {}
			observe(target: Element) {
				this.callback(
					[{ isIntersecting: true, target } as IntersectionObserverEntry],
					this as never,
				);
			}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	document.body.replaceChildren();
});

describe("MermaidBlock", () => {
	it("renders with the Agentero dark theme and keeps the source one click away", async () => {
		const { host, root } = renderBlock();
		await act(async () =>
			root.render(createElement(MermaidBlock, { source: SOURCE })),
		);
		await act(async () => {
			vi.advanceTimersByTime(250);
		});
		await act(async () => {});

		expect(render).toHaveBeenCalledOnce();
		const config = getMermaid.mock.calls[0]?.[0] as {
			theme: string;
			themeVariables: { nodeTextColor: string };
		};
		expect(config.theme).toBe("base");
		// Dark neutrals from the design tokens, never Mermaid's own palette.
		expect(config.themeVariables.nodeTextColor).toBe("#f7f8fb");
		expect(host.querySelector("[data-mermaid-canvas]")).not.toBeNull();

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="mermaid.viewSource"]')
				?.click(),
		);
		expect(host.querySelector("pre")?.textContent).toContain("graph LR");

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="mermaid.copySource"]')
				?.click(),
		);
		expect(copyTextToClipboard).toHaveBeenCalledWith(SOURCE, {
			successMessage: "mermaid.copySource",
		});

		await act(async () => root.unmount());
	});

	it("shows the fence source instead of rendering while it is still streaming", async () => {
		const { host, root } = renderBlock();
		await act(async () =>
			root.render(
				createElement(MermaidBlock, { source: SOURCE, streaming: true }),
			),
		);
		await act(async () => {
			vi.advanceTimersByTime(250);
		});

		expect(render).not.toHaveBeenCalled();
		expect(host.querySelector("[data-mermaid-canvas]")).toBeNull();
		expect(host.querySelector("pre")?.textContent).toContain("graph LR");

		await act(async () => root.unmount());
	});
});
