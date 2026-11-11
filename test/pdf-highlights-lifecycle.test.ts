// @vitest-environment happy-dom

import { PdfAnnotationSubtype } from "@embedpdf/models";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type UsePdfHighlightsOptions,
	usePdfHighlights,
} from "@/components/viewer/pdf/hooks/use-pdf-highlights";

const io = vi.hoisted(() => ({
	load: vi.fn(),
	watch: vi.fn(() => () => {}),
}));
vi.mock("@/lib/pdf/highlight/annotation-store", async (importOriginal) => ({
	...(await importOriginal<object>()),
	loadAnnotationItems: io.load,
	hasAnnotationsFile: async () => true,
}));
vi.mock("@/lib/vault/file-change-gate", () => ({
	listenVaultFileChangedGated: io.watch,
}));

let root: Root | null;
let disposed: boolean;
let onEvent: ((event: { type: "loaded" }) => void) | undefined;
let reads: number;
const options = () =>
	({
		annotationCap: {
			forDocument: () => ({
				getState: () => ({ pages: { 0: [] } }),
				getAnnotations: () => {
					if (disposed) throw new Error("annotation plugin was destroyed");
					reads++;
					return [];
				},
				onAnnotationEvent: (listener: typeof onEvent) => {
					onEvent = listener;
					return () => {};
				},
				onStateChange: () => () => {},
			}),
		},
		docCap: { getDocument: () => ({ pages: [] }) },
		docId: "doc",
		paperAbsPath: "/vault/papers/test",
		paperKey: "test",
		totalPages: 1,
		onHighlightsChangeRef: { current: undefined },
	}) as unknown as UsePdfHighlightsOptions;

function Fixture(props: UsePdfHighlightsOptions) {
	usePdfHighlights(props);
	return null;
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	disposed = false;
	onEvent = undefined;
	reads = 0;
	io.load.mockReset().mockResolvedValue([]);
	root = createRoot(document.createElement("div"));
});
async function unmount() {
	await act(() => root?.unmount());
	root = null;
	disposed = true;
}
afterEach(async () => {
	if (root) await unmount();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("cancels the post-import timer before the annotation plugin is destroyed", async () => {
	await act(() => root?.render(createElement(Fixture, options())));
	await unmount();
	await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
});

it("ignores an annotation-file read completed after unmount", async () => {
	let finish!: (items: []) => void;
	io.load.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await act(() => root?.render(createElement(Fixture, options())));
	await unmount();
	finish([]);
	await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
});

it("discards a queued rebuild when its subscription unmounts", async () => {
	const queued: (() => void)[] = [];
	vi.stubGlobal("queueMicrotask", (callback: () => void) =>
		queued.push(callback),
	);
	await act(() => root?.render(createElement(Fixture, options())));
	const readsBeforeEvent = reads;
	onEvent?.({ type: "loaded" });
	await unmount();
	expect(() => {
		for (const callback of queued) callback();
	}).not.toThrow();
	expect(reads).toBe(readsBeforeEvent);
});

it("restarts an interrupted import during StrictMode setup and publishes live annotations", async () => {
	const published = vi.fn();
	const props = { ...options(), onHighlightsChangeRef: { current: published } };
	await act(() =>
		root?.render(
			createElement(StrictMode, null, createElement(Fixture, props)),
		),
	);
	const beforeSettle = published.mock.calls.length;
	await act(() => vi.runAllTimersAsync());
	expect(io.load).toHaveBeenCalledTimes(2);
	expect(published.mock.calls.length).toBeGreaterThan(beforeSettle);
});

it("waits for native annotation loading before deduplicating a saved link", async () => {
	const annotation = {
		id: "native",
		type: PdfAnnotationSubtype.LINK,
		pageIndex: 0,
		rect: { origin: { x: 10, y: 20 }, size: { width: 30, height: 10 } },
		target: { type: "uri", uri: "https://example.org/reference" },
	};
	const imports = vi.fn();
	let loaded = false;
	const listeners = new Set<(event: { type: "loaded" }) => void>();
	const scope = {
		onStateChange: () => () => {},
		getState: () => ({ pages: loaded ? { 0: ["native"] } : {} }),
		getAnnotations: () =>
			loaded ? [{ object: annotation, commitState: "synced" }] : [],
		onAnnotationEvent: (listener: (event: { type: "loaded" }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		importAnnotations: imports,
	};
	const props = {
		...options(),
		annotationCap: { forDocument: () => scope },
	} as unknown as UsePdfHighlightsOptions;
	io.load.mockResolvedValue([
		{ annotation: { ...annotation, id: "saved-before-reopen" } },
	]);
	await act(() => root?.render(createElement(Fixture, props)));
	await act(() => vi.runAllTimersAsync());
	expect(imports).not.toHaveBeenCalled();
	loaded = true;
	await act(async () => {
		for (const listener of listeners) listener({ type: "loaded" });
	});
	await act(() => vi.runAllTimersAsync());
	expect(io.load).toHaveBeenCalledOnce();
	expect(imports).not.toHaveBeenCalled();
	await unmount();
	expect(listeners.size).toBe(0);
});

it("does not start a waiting sidecar import after its viewer closes", async () => {
	const listeners = new Set<(event: { type: "loaded" }) => void>();
	const props = {
		...options(),
		annotationCap: {
			forDocument: () => ({
				onStateChange: () => () => {},
				getState: () => ({ pages: {} }),
				getAnnotations: () => [],
				onAnnotationEvent: (listener: (event: { type: "loaded" }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			}),
		},
	} as unknown as UsePdfHighlightsOptions;
	await act(() => root?.render(createElement(Fixture, props)));
	await unmount();
	for (const listener of listeners) listener({ type: "loaded" });
	await vi.runAllTimersAsync();
	expect(io.load).not.toHaveBeenCalled();
	expect(listeners.size).toBe(0);
});
