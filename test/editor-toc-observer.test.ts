// @vitest-environment happy-dom

/**
 * Regression guard for the `@platejs/toc` scroll cost (see
 * `docs/bug_fix/toc-scroll-observer-rebuild.md`).
 *
 * Upstream rebuilt the heading `IntersectionObserver` on every scroll event:
 * `useContentController` bumped a `status` state, and `useContentObserver` had
 * that `status` in its effect deps, so each event tore the observer down and
 * re-ran `NodeApi.get` + `toDOMNode` + `observe` for every heading. On macOS a
 * scrollbar thumb drag is driven on the main thread per pointer event, so that
 * cost showed up directly as the thumb failing to follow.
 *
 * The assertions below fail on the unpatched 53.0.0 build: scrolling would add
 * an observer per event and re-observe every heading.
 */

import { H1Plugin, H2Plugin } from "@platejs/basic-nodes/react";
import { TocPlugin } from "@platejs/toc/react";
import {
	ParagraphPlugin,
	Plate,
	PlateContent,
	usePlateEditor,
} from "platejs/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	H1Element,
	H2Element,
} from "@/components/editor/nodes/block/heading-node";
import { ParagraphElement } from "@/components/editor/nodes/block/paragraph-node";
import {
	queryTocHeadings,
	TocSidebar,
} from "@/components/editor/overlays/toc-sidebar";

const HEADINGS = ["alpha", "beta", "gamma", "delta"];

type ObserverRecord = {
	callback: IntersectionObserverCallback;
	observed: Set<Element>;
	observe: ReturnType<typeof vi.fn>;
	unobserve: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
};

let observers: ObserverRecord[] = [];
let root: Root;
let container: HTMLDivElement;
let mountedEditor: ReturnType<typeof usePlateEditor> | null = null;

/** Total `observe` calls across every observer built since the last reset. */
const observeCalls = () =>
	observers.reduce(
		(total, entry) => total + entry.observe.mock.calls.length,
		0,
	);

const disconnectCalls = () =>
	observers.filter((entry) => entry.disconnect.mock.calls.length > 0).length;

/** The heading observer is the one tracking the whole heading list. */
function headingObserver(): ObserverRecord {
	const found = observers.find(
		(entry) => entry.observed.size >= HEADINGS.length,
	);
	if (!found) throw new Error("heading observer was never constructed");
	return found;
}

function Fixture() {
	const editor = usePlateEditor({
		plugins: [
			ParagraphPlugin.withComponent(ParagraphElement),
			H1Plugin.withComponent(H1Element),
			H2Plugin.withComponent(H2Element),
			TocPlugin.configure({ options: { queryHeading: queryTocHeadings } }),
		],
		value: [
			{ id: "alpha", type: "h1", children: [{ text: "Alpha" }] },
			{ id: "lead", type: "p", children: [{ text: "lead" }] },
			{ id: "beta", type: "h2", children: [{ text: "Beta" }] },
			{ id: "gamma", type: "h2", children: [{ text: "Gamma" }] },
			{ id: "delta", type: "h2", children: [{ text: "Delta" }] },
		],
	});

	mountedEditor = editor;

	return createElement(
		Plate,
		{ editor },
		createElement(PlateContent, null),
		createElement(TocSidebar, {
			rootMargin: "-8px 0px -80% 0px",
			topOffset: 16,
		}),
	);
}

/** Scroll events, then the rAF the patched hook coalesces its sync into. */
async function scroll(times: number) {
	await act(async () => {
		for (let index = 0; index < times; index += 1) {
			window.dispatchEvent(new Event("scroll"));
		}
		vi.advanceTimersByTime(50);
	});
}

beforeEach(() => {
	observers = [];
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers({
		toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
	});
	vi.advanceTimersByTime(1000);

	// Mirror Tauri's webview, where the IntersectionObserver API exists but no
	// layout is performed.
	class MockIntersectionObserver {
		callback: IntersectionObserverCallback;
		observed = new Set<Element>();
		observe = vi.fn((element: Element) => {
			this.observed.add(element);
		});
		unobserve = vi.fn((element: Element) => {
			this.observed.delete(element);
		});
		disconnect = vi.fn(() => {
			this.observed.clear();
		});
		constructor(callback: IntersectionObserverCallback) {
			this.callback = callback;
			observers.push(this as unknown as ObserverRecord);
		}
	}
	vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Markdown TOC heading observer", () => {
	it("observes every heading once after mount", async () => {
		await act(async () => {
			root.render(createElement(Fixture));
		});

		const observer = headingObserver();
		expect(observer.observed.size).toBe(HEADINGS.length);
		expect([...observer.observed].map((element) => element.id).sort()).toEqual(
			[...HEADINGS].sort(),
		);
	});

	it("does not rebuild or re-observe the heading observer while scrolling", async () => {
		await act(async () => {
			root.render(createElement(Fixture));
		});

		const afterMount = observers.length;
		const observesAfterMount = observeCalls();

		await scroll(20);

		// Unpatched: one extra observer per scroll event, each re-observing all
		// four headings.
		expect(observers.length).toBe(afterMount);
		expect(observeCalls()).toBe(observesAfterMount);
		expect(headingObserver().disconnect).not.toHaveBeenCalled();
	});

	it("keeps re-attaching once the heading DOM is remounted", async () => {
		await act(async () => {
			root.render(createElement(Fixture));
		});

		const editor = mountedEditor;
		if (!editor) throw new Error("editor was not mounted");
		const observer = headingObserver();
		const target = document.getElementById("beta");
		if (!target) throw new Error("heading element missing");

		// Stand in for Slate remounting a block: the heading's DOM node is
		// replaced, so `toDOMNode` starts reporting the fresh element.
		const replacement = document.createElement("h2");
		replacement.id = "beta";
		const toDOMNode = editor.api.toDOMNode.bind(editor.api);
		editor.api.toDOMNode = ((node: Parameters<typeof toDOMNode>[0]) => {
			const element = toDOMNode(node);
			return element === target ? replacement : element;
		}) as typeof editor.api.toDOMNode;

		await scroll(1);

		expect(observer.unobserve).toHaveBeenCalledWith(target);
		expect(observer.observe).toHaveBeenCalledWith(replacement);
		expect(observer.observed.has(target)).toBe(false);
		expect(observer.observed.has(replacement)).toBe(true);
	});

	it("still tracks the active heading from observer callbacks", async () => {
		await act(async () => {
			root.render(createElement(Fixture));
		});

		const observer = headingObserver();
		const gamma = document.getElementById("gamma");
		if (!gamma) throw new Error("heading element missing");

		await act(async () => {
			observer.callback(
				[
					{
						isIntersecting: true,
						target: gamma,
					} as unknown as IntersectionObserverEntry,
				],
				observer as unknown as IntersectionObserver,
			);
		});

		expect(container.querySelector("#toc_item_active")?.id).toBe(
			"toc_item_active",
		);
		expect(
			container.querySelector("#toc_item_active")?.getAttribute("aria-label"),
		).toBe("Gamma");
	});
});

describe("patched toc observer contract", () => {
	it("leaves the scroll path free of React state updates", async () => {
		await act(async () => {
			root.render(createElement(Fixture));
		});

		// A scroll that changes nothing must not re-render the sidebar: before
		// the patch every event set `status`, re-rendering the whole button list.
		const before = container.querySelector("#toc_wrap")?.innerHTML;
		await scroll(5);

		expect(container.querySelector("#toc_wrap")?.innerHTML).toBe(before);
		expect(disconnectCalls()).toBe(0);
	});
});
