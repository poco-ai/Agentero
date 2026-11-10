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
		expect(host.querySelector('[aria-label="mermaid.copySource"]')).toBeNull();

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="mermaid.viewSource"]')
				?.click(),
		);
		const codeBlock = host.querySelector('[data-slot="code-block"]');
		expect(
			codeBlock?.querySelector('[data-slot="code-block-title"]')?.textContent,
		).toBe("mermaid");
		expect(codeBlock?.querySelector("pre")?.textContent).toContain("graph LR");
		await act(async () => {
			await vi.dynamicImportSettled();
			await Promise.resolve();
		});
		const graphToken = [
			...(codeBlock?.querySelectorAll<HTMLElement>(
				'[data-slot="code-block-code"] span',
			) ?? []),
		].find((token) => token.textContent === "graph");
		expect(graphToken?.style.getPropertyValue("--shiki-light")).toBe("#D73A49");
		expect(
			host.querySelector('[aria-label="mermaid.copySource"]'),
		).not.toBeNull();

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="mermaid.copySource"]')
				?.click(),
		);
		expect(copyTextToClipboard).toHaveBeenCalledWith(SOURCE, {
			successMessage: "mermaid.copySource",
		});

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="mermaid.viewDiagram"]')
				?.click(),
		);
		expect(host.querySelector('[data-slot="code-block"]')).toBeNull();
		expect(host.querySelector('[aria-label="mermaid.copySource"]')).toBeNull();
		expect(host.querySelector("[data-mermaid-canvas]")).not.toBeNull();

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
		expect(
			host.querySelector('[aria-label="mermaid.copySource"]'),
		).not.toBeNull();

		await act(async () => root.unmount());
	});

	it("zooms inside a fixed viewport without changing the message layout", async () => {
		const { host, root } = renderBlock();
		await act(async () =>
			root.render(createElement(MermaidBlock, { source: SOURCE })),
		);
		await act(async () => {
			vi.advanceTimersByTime(250);
		});
		await act(async () => {});

		const canvas = host.querySelector<HTMLElement>("[data-mermaid-canvas]");
		const stage = host.querySelector<HTMLElement>("[data-mermaid-stage]");
		const height = canvas?.style.height;
		expect(stage?.style.transform).toContain("scale(1)");
		if (canvas) {
			Object.defineProperties(canvas, {
				clientWidth: { configurable: true, value: 232 },
				clientHeight: { configurable: true, value: 132 },
			});
		}

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="mermaid.zoomIn"]')
				?.click(),
		);
		expect(stage?.style.transform).toContain("scale(1.2)");
		expect(canvas?.style.height).toBe(height);
		expect(
			host.querySelector('[aria-label="mermaid.resetZoom"]')?.textContent,
		).toBe("120%");

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="mermaid.fitToView"]')
				?.click(),
		);
		expect(stage?.style.transform).toContain("scale(0.34)");
		await act(async () => root.unmount());
	});

	it("opens a fullscreen Mermaid viewer and closes it with Escape", async () => {
		const { host, root } = renderBlock();
		await act(async () =>
			root.render(createElement(MermaidBlock, { source: SOURCE })),
		);
		await act(async () => {
			vi.advanceTimersByTime(250);
		});
		await act(async () => {});

		await act(async () =>
			host
				.querySelector<HTMLButtonElement>(
					'[aria-label="mermaid.viewFullscreen"]',
				)
				?.click(),
		);
		expect(document.querySelector("[data-mermaid-fullscreen]")).not.toBeNull();

		await act(async () => {
			document
				.querySelector("[data-mermaid-fullscreen]")
				?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
				);
			await Promise.resolve();
		});
		expect(document.querySelector("[data-mermaid-fullscreen]")).toBeNull();
		await act(async () => root.unmount());
	});
});
