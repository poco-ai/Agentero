// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMarkdownResizeFreeze,
	MARKDOWN_QUERY_CONTAINER_SELECTOR,
} from "@/lib/workspace/markdown-resize-freeze";
import type { ResizeGesture } from "@/lib/workspace/resize-gesture";

/** Minimal gesture stand-in: the real one is covered by resize-gesture.test.ts. */
function fakeGesture() {
	const listeners = new Set<(active: boolean) => void>();
	const gesture: ResizeGesture & { emit: (active: boolean) => void } = {
		begin: () => {},
		end: () => {},
		isActive: () => false,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => listeners.clear(),
		emit: (active) => {
			for (const listener of [...listeners]) listener(active);
		},
	};
	return gesture;
}

/**
 * Mirror the editor DOM the freeze walks: a pane that resizes, and one level in
 * the `@container/editor` query container whose width the gesture pins.
 */
function mountContainer(width: number, pane: HTMLElement) {
	const container = document.createElement("div");
	container.setAttribute("data-editor-query-container", "");
	container.getBoundingClientRect = () =>
		({ width, height: 600 }) as unknown as DOMRect;
	const scroller = document.createElement("div");
	const editor = document.createElement("div");
	editor.setAttribute("data-slate-editor", "");
	editor.setAttribute("data-selection-chat-origin", "markdown");
	scroller.append(editor);
	container.append(scroller);
	pane.append(container);
	return { container, scroller, editor };
}

let pane: HTMLElement;

function newPane() {
	pane = document.createElement("div");
	document.body.append(pane);
	return pane;
}

afterEach(() => {
	pane?.remove();
});

describe("Markdown resize freeze", () => {
	it("pins each query container to its measured width for the gesture", () => {
		const root = newPane();
		const a = mountContainer(623.4531, root);
		const b = mountContainer(410, root);
		const gesture = fakeGesture();
		createMarkdownResizeFreeze(root, gesture);

		gesture.emit(true);
		// Fractional width in, fractional width out: rounding would itself change
		// the container size and re-run the query.
		expect(a.container.style.width).toBe("623.4531px");
		expect(b.container.style.width).toBe("410px");

		gesture.emit(false);
		expect(a.container.style.width).toBe("");
		expect(b.container.style.width).toBe("");
	});

	it("leaves the editor and its scroller untouched", () => {
		const root = newPane();
		const { scroller, editor } = mountContainer(800, root);
		const gesture = fakeGesture();
		createMarkdownResizeFreeze(root, gesture);

		gesture.emit(true);

		// Pinning the container is enough: the editor is `w-full` inside it, so
		// touching these would only fight React-owned styles.
		expect(editor.style.width).toBe("");
		expect(scroller.style.overflowX).toBe("");
	});

	it("restores an inline width it did not own", () => {
		const root = newPane();
		const { container } = mountContainer(500, root);
		container.style.width = "42%";
		const gesture = fakeGesture();
		const freeze = createMarkdownResizeFreeze(root, gesture);

		freeze.begin();
		expect(container.style.width).toBe("500px");

		freeze.end();
		expect(container.style.width).toBe("42%");
	});

	it("skips collapsed panes and panes without a query container", () => {
		const root = newPane();
		const collapsed = mountContainer(0, root);
		const bare = document.createElement("div");
		bare.getBoundingClientRect = () =>
			({ width: 640, height: 400 }) as unknown as DOMRect;
		root.append(bare);
		const gesture = fakeGesture();
		createMarkdownResizeFreeze(root, gesture);

		gesture.emit(true);

		expect(collapsed.container.style.width).toBe("");
		expect(bare.style.width).toBe("");
	});

	it("does not re-measure while already pinned", () => {
		const root = newPane();
		const { container } = mountContainer(320, root);
		container.getBoundingClientRect = vi.fn(
			() => ({ width: 320, height: 600 }) as unknown as DOMRect,
		);
		const gesture = fakeGesture();
		createMarkdownResizeFreeze(root, gesture);

		gesture.emit(true);
		gesture.emit(true);
		expect(container.style.width).toBe("320px");
		// Re-entering must not re-read (and re-pin to) an already pinned width.
		expect(container.getBoundingClientRect).toHaveBeenCalledTimes(1);
	});

	it("stops reacting to the gesture once disposed", () => {
		const root = newPane();
		const { container } = mountContainer(300, root);
		const gesture = fakeGesture();
		const freeze = createMarkdownResizeFreeze(root, gesture);

		freeze.begin();
		freeze.dispose();
		expect(container.style.width).toBe("");

		gesture.emit(true);
		expect(container.style.width).toBe("");
	});

	it("keeps its selector in sync with the editor markup", () => {
		expect(MARKDOWN_QUERY_CONTAINER_SELECTOR).toBe(
			"[data-editor-query-container]",
		);
	});
});
