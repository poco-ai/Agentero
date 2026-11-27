// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableGroup, ResizablePanel } from "@/components/ui/resizable";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// The panel library measures the group; happy-dom has no ResizeObserver.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function render(panelStyle?: React.CSSProperties) {
	await act(async () => {
		root.render(
			createElement(
				ResizableGroup,
				{ orientation: "horizontal" },
				createElement(
					ResizablePanel,
					{ id: "rail", minSize: 120, style: panelStyle },
					createElement("div", null, "pane"),
				),
			),
		);
	});
	const panel = container.querySelector<HTMLElement>("[data-panel]");
	const content = panel?.firstElementChild as HTMLElement | null;
	if (!content) throw new Error("panel content wrapper missing");
	return content;
}

describe("resizable panel content wrapper", () => {
	it("never scrolls, even though the library defaults the wrapper to auto", async () => {
		const content = await render();
		// Inline style must beat the library's own inline `overflow: auto`.
		expect(content.style.overflow).toBe("hidden");
	});

	it("lets a caller opt back into scrolling", async () => {
		const content = await render({ overflow: "auto" });
		expect(content.style.overflow).toBe("auto");
	});
});
