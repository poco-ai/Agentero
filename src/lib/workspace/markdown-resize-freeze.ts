/**
 * Freeze live Markdown layout while a pane resize gesture is in flight.
 *
 * Pinning the editor's own width was not enough. Measured on WebKit with a
 * 441-block document (see `tmp/harness`, Playwright WebKit 27.2):
 *
 * | scenario                        | median frame |
 * |---------------------------------|--------------|
 * | no resize (floor)               | 17.0ms       |
 * | resize, nothing pinned          | 42.0ms       |
 * | resize, editor width pinned     | 39.0ms       |
 * | resize, query container pinned  | 17.0ms       |
 *
 * So ~24 of the 25ms came from the `@container/editor` query container
 * re-running style for its subtree on every frame, not from the document
 * re-wrapping (~3ms). Pinning the container fixes both: its size no longer
 * changes, so the query does not re-run, and the editor inside keeps the width
 * it had when the gesture started.
 *
 * `content-visibility: auto` is the Chromium answer to the re-wrap and stays
 * gated off on WebKit (`lib/core/paint-perf.ts`): Chromium lays out about a
 * screen and a half ahead of the viewport while WebKit only reveals content on
 * entry, so enabling it there moves the jank from resizing to scrolling
 * (WebKit #276735, still open). Enabling it also measured no better than the
 * baseline for resizing here (42.0ms vs 42.0ms).
 *
 * The pane keeps following the pointer — `.agentero-dock-sash-active` already
 * puts `contain: paint` on the view, so the pinned overflow is clipped instead
 * of spilling — and everything re-lays out once, on release.
 *
 * Which gestures count is `resize-gesture.ts`'s job, not this module's.
 */

import type { ResizeGesture } from "@/lib/workspace/resize-gesture";

export const MARKDOWN_QUERY_CONTAINER_SELECTOR =
	"[data-editor-query-container]";

export type MarkdownResizeFreeze = {
	/** Pin now, for a caller that wants to freeze outside the gesture signal. */
	begin: () => void;
	/** Release now. */
	end: () => void;
	dispose: () => void;
};

type PinnedContainer = {
	element: HTMLElement;
	/** Inline width before the gesture, so React-owned styles are restored. */
	width: string;
};

function captureReadingPosition(container: HTMLElement) {
	const scroller = container.querySelector<HTMLElement>(
		":scope > [data-agentero-editor]",
	);
	if (!scroller || scroller.scrollTop <= 0) return null;
	const editor = scroller.querySelector(":scope > [data-slate-editor]");
	const doc = container.ownerDocument;
	const view = doc.defaultView;
	if (!editor || !view) return null;

	const viewport = scroller.getBoundingClientRect();
	const x =
		editor.getBoundingClientRect().left +
		Number.parseFloat(view.getComputedStyle(editor).paddingLeft) +
		1;

	// Probe near the first visible line, with a second point for block spacing.
	for (const inset of [8, 32]) {
		const y = viewport.top + inset;
		if (y >= viewport.bottom) break;
		const hit = doc.elementFromPoint(x, y);
		if (!hit || hit === editor || !editor.contains(hit)) continue;

		const range = doc.caretRangeFromPoint?.(x, y);
		let target: Range | Element = hit;
		if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
			const text = range.startContainer as Text;
			if (hit.contains(text) && text.length > 0) {
				// A collapsed caret can resolve to either side of a soft wrap.
				const offset = Math.min(range.startOffset, text.length - 1);
				range.setStart(text, offset);
				range.setEnd(text, offset + 1);
				target = range;
			}
		}
		const offset = target.getBoundingClientRect().top - viewport.top;
		return () => {
			const node = target instanceof Element ? target : target.startContainer;
			if (!scroller.contains(node)) return;
			const delta =
				target.getBoundingClientRect().top -
				scroller.getBoundingClientRect().top -
				offset;
			if (Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
		};
	}
	return null;
}

export function createMarkdownResizeFreeze(
	root: Pick<HTMLElement, "querySelectorAll">,
	gesture: ResizeGesture,
): MarkdownResizeFreeze {
	let pinned: PinnedContainer[] = [];

	const release = () => {
		for (const container of pinned) {
			container.element.style.width = container.width;
		}
		pinned = [];
	};

	const end = () => {
		// Dockview lays out the resized panes while the text width is pinned.
		// Read the visible anchors before unpinning, then restore after reflow.
		const restorePositions = pinned.map(({ element }) =>
			captureReadingPosition(element),
		);
		release();
		for (const restorePosition of restorePositions) restorePosition?.();
	};

	const begin = () => {
		// Re-entering must not strand the previous gesture's inline styles.
		if (pinned.length > 0) return;
		for (const element of root.querySelectorAll<HTMLElement>(
			MARKDOWN_QUERY_CONTAINER_SELECTOR,
		)) {
			const width = element.getBoundingClientRect().width;
			// A collapsed or not-yet-laid-out pane has no width worth pinning.
			if (!(width > 0)) continue;
			pinned.push({ element, width: element.style.width });
			// Fractional width in, fractional width out: rounding would itself
			// change the container size and re-run the query.
			element.style.width = `${width}px`;
		}
	};

	const unsubscribe = gesture.subscribe((active) => {
		if (active) begin();
		else end();
	});

	return {
		begin,
		end,
		dispose: () => {
			unsubscribe();
			release();
		},
	};
}
