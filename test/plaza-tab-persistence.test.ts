// @vitest-environment happy-dom
import { act, createElement, StrictMode, Suspense, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocView, type DocViewProps } from "@/components/workspace/doc-view";

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("@/components/library/papers-library", () => ({
	PapersLibrary: () => null,
}));
vi.mock("@/components/viewer", () => ({
	HtmlViewer: () => null,
	ImageViewer: () => null,
}));
vi.mock("@/components/viewer/local-html-viewer", () => ({
	LocalHtmlViewer: () => null,
}));
vi.mock("@/components/workspace/recycle-bin-view", () => ({
	RecycleBinView: () => null,
}));
vi.mock("@/components/writing/tex-project-view", () => ({
	TexProjectView: () => null,
}));
vi.mock("@/hooks/use-app-stores", () => ({ useSettings: () => true }));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/workspace/navigation", () => ({
	openWritingFile: vi.fn(),
	rememberWritingSource: vi.fn(),
}));
vi.mock("@/lib/workspace/store", () => ({ updateTab: vi.fn() }));
vi.mock("@/lib/writing/project-target", () => ({
	isWritingPath: () => false,
	resolveWritingTarget: vi.fn(),
}));
vi.mock("@/components/plaza/plaza-view", () => ({
	PlazaView: ({ path }: { path: string }) => {
		useEffect(() => {
			lifecycle.mounts++;
			return () => {
				lifecycle.unmounts++;
			};
		}, []);
		return createElement("iframe", {
			title: path,
			srcDoc: "<html><body></body></html>",
		});
	},
}));

let container: HTMLDivElement;
let root: Root;
function tab(active: boolean, path = "modelscope") {
	return createElement(
		Suspense,
		{ fallback: null },
		createElement(DocView, {
			active,
			keepMounted: false,
			vaultPath: null,
			tab: { id: path, path, kind: "plaza", mode: "markdown", loaded: true },
			pdf: {},
			editor: {},
		} as DocViewProps),
	);
}
async function render(active: boolean, path = "modelscope") {
	await act(async () => {
		root.render(tab(active, path));
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	lifecycle.mounts = 0;
	lifecycle.unmounts = 0;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("Plaza tab lifetime", () => {
	it("does not load restored background tabs before the first visit", async () => {
		await render(false);
		expect(container.querySelector("iframe")).toBeNull();
		expect(lifecycle.mounts).toBe(0);
		await render(true);
		expect(container.querySelector("iframe")).not.toBeNull();
		expect(lifecycle.mounts).toBe(1);
	});

	it("preserves the iframe, document and page state across repeated focus changes", async () => {
		await render(true);
		const frame = container.querySelector("iframe");
		expect(frame).not.toBeNull();
		const page = frame?.contentDocument;
		const input = page?.createElement("input");
		expect(input).toBeDefined();
		if (!input) throw new Error("missing iframe document");
		input.value = "unsent query";
		page?.body.append(input);
		for (let i = 0; i < 3; i++) {
			await render(false);
			expect(container.querySelector("iframe")).toBe(frame);
			await render(true);
			expect(container.querySelector("iframe")).toBe(frame);
			expect(frame?.contentDocument).toBe(page);
			expect(frame?.contentDocument?.querySelector("input")?.value).toBe(
				"unsent query",
			);
		}
		expect(lifecycle.mounts).toBe(1);
		expect(lifecycle.unmounts).toBe(0);
	});

	it("releases a closed tab and creates a fresh page when reopened", async () => {
		await render(true);
		const frame = container.querySelector("iframe");
		await act(() => root.render(null));
		expect(frame?.isConnected).toBe(false);
		expect(lifecycle.unmounts).toBe(1);
		await render(false);
		expect(container.querySelector("iframe")).toBeNull();
		await render(true);
		expect(container.querySelector("iframe")).not.toBe(frame);
		expect(lifecycle.mounts).toBe(2);
	});

	it("does not inherit the visited state when the tab identity changes", async () => {
		await render(true);
		await render(false, "another-source");
		expect(container.querySelector("iframe")).toBeNull();
		expect(lifecycle.unmounts).toBe(1);
		await render(true, "another-source");
		expect(container.querySelector("iframe")?.title).toBe("another-source");
	});

	it("keeps visited and unvisited source tabs independent", async () => {
		await act(async () => {
			root.render(createElement("div", null, tab(true), tab(false, "other")));
		});
		const frame = container.querySelector("iframe");
		await act(async () => {
			root.render(createElement("div", null, tab(false), tab(false, "other")));
		});
		expect(container.querySelectorAll("iframe")).toHaveLength(1);
		expect(container.querySelector("iframe")).toBe(frame);
	});

	it("retains the committed iframe under StrictMode", async () => {
		await act(async () => {
			root.render(createElement(StrictMode, null, tab(true)));
		});
		const frame = container.querySelector("iframe");
		const mounts = lifecycle.mounts;
		await act(async () => {
			root.render(createElement(StrictMode, null, tab(false)));
		});
		await act(async () => {
			root.render(createElement(StrictMode, null, tab(true)));
		});
		expect(container.querySelector("iframe")).toBe(frame);
		expect(lifecycle.mounts).toBe(mounts);
	});
});
