// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CARD_RESIZE_QUIET_MS,
	readPdfCardWidth,
	watchCardWidthResize,
	writePdfCardWidth,
} from "@/lib/pdf/card-size";

const STORAGE_KEY = "agentero-pdf-card-widths";

class MockResizeObserver {
	static instances: MockResizeObserver[] = [];
	callback: ResizeObserverCallback;
	observed: Element[] = [];
	disconnected = false;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		MockResizeObserver.instances.push(this);
	}
	observe(element: Element) {
		this.observed.push(element);
	}
	unobserve() {}
	disconnect() {
		this.disconnected = true;
	}
	fire() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

function lastObserver() {
	const observer = MockResizeObserver.instances.at(-1);
	if (!observer) throw new Error("observer was not constructed");
	return observer;
}

/** Inline-size element with a measurable box (happy-dom has no layout). */
function sizedElement(): HTMLElement {
	const element = document.createElement("div");
	document.body.append(element);
	Object.defineProperty(element, "offsetWidth", {
		configurable: true,
		value: 420,
	});
	Object.defineProperty(element, "offsetHeight", {
		configurable: true,
		value: 360,
	});
	return element;
}

/** Node 25 ships a stub localStorage here; give the module a real in-memory one. */
function memoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
		clear: () => map.clear(),
	};
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
	vi.useFakeTimers();
	storage = memoryStorage();
	vi.stubGlobal("localStorage", storage);
	MockResizeObserver.instances = [];
	vi.stubGlobal("ResizeObserver", MockResizeObserver);
	(
		document.defaultView as unknown as { ResizeObserver: unknown }
	).ResizeObserver = MockResizeObserver;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("card width storage", () => {
	it("round-trips a width per card kind", () => {
		writePdfCardWidth("translate", 420);
		writePdfCardWidth("ask", 300);

		expect(readPdfCardWidth("translate")).toBe(420);
		expect(readPdfCardWidth("ask")).toBe(300);
		expect(readPdfCardWidth("missing")).toBeNull();
	});

	it("clamps and rounds into a usable range", () => {
		writePdfCardWidth("translate", 12.6);
		expect(readPdfCardWidth("translate")).toBe(120);
		writePdfCardWidth("translate", 99999);
		expect(readPdfCardWidth("translate")).toBe(4000);
	});

	it("ignores corrupt entries", () => {
		storage.setItem(STORAGE_KEY, "{not json");
		expect(readPdfCardWidth("translate")).toBeNull();

		storage.setItem(
			STORAGE_KEY,
			JSON.stringify({ translate: { width: "wide" } }),
		);
		expect(readPdfCardWidth("translate")).toBeNull();

		storage.setItem(STORAGE_KEY, JSON.stringify(["nope"]));
		expect(readPdfCardWidth("translate")).toBeNull();
	});
});

describe("watchCardWidthResize", () => {
	it("reports the dragged width once the drag settles", () => {
		const element = sizedElement();
		const onWidth = vi.fn();
		watchCardWidthResize(element, onWidth);

		lastObserver().fire(); // priming callback
		expect(onWidth).not.toHaveBeenCalled();

		element.style.width = "420px";
		element.style.height = "360px";
		lastObserver().fire();
		expect(onWidth).not.toHaveBeenCalled();

		vi.advanceTimersByTime(CARD_RESIZE_QUIET_MS);
		expect(onWidth).toHaveBeenCalledExactlyOnceWith(420);
	});

	it("ignores content growth and width-only re-layout", () => {
		const element = sizedElement();
		const onWidth = vi.fn();
		watchCardWidthResize(element, onWidth);
		lastObserver().fire();

		// Content grew: no inline height, so nothing was dragged.
		lastObserver().fire();
		vi.advanceTimersByTime(CARD_RESIZE_QUIET_MS * 2);
		expect(onWidth).not.toHaveBeenCalled();

		// Viewport re-laid the card out: only the width changed.
		element.style.width = "300px";
		lastObserver().fire();
		vi.advanceTimersByTime(CARD_RESIZE_QUIET_MS * 2);
		expect(onWidth).not.toHaveBeenCalled();
	});

	it("drops a pending width when disposed", () => {
		const element = sizedElement();
		const onWidth = vi.fn();
		const dispose = watchCardWidthResize(element, onWidth);
		lastObserver().fire();

		element.style.width = "420px";
		element.style.height = "360px";
		lastObserver().fire();
		dispose();
		vi.advanceTimersByTime(CARD_RESIZE_QUIET_MS * 2);

		expect(onWidth).not.toHaveBeenCalled();
		expect(lastObserver().disconnected).toBe(true);
	});
});
