// @vitest-environment happy-dom

import i18next from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WritingPdfBar } from "@/components/writing/writing-pdf-bar";
import zhLatex from "@/i18n/locales/zh-CN/latexBuild.json";
import zhSidebar from "@/i18n/locales/zh-CN/sidebar.json";
import {
	beginTexBuild,
	finishTexBuild,
	receiveTexLog,
	texBuildStore,
} from "@/lib/tex/build-state";
import { texCompileStore } from "@/lib/workspace/tex-compile";
import { COMPILE_SUCCESS_FLASH_MS } from "@/lib/writing/compile-button";

const compileTexProject = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/core/bindings", () => ({
	commands: {
		detectLatexEngines: vi.fn(async () => ({
			ok: true,
			data: [{ id: "xelatex", label: "XeLaTeX", path: "xelatex" }],
		})),
		rtexStatus: vi.fn(async () => ({ ok: true, data: { available: false } })),
		resolveLatexRoot: vi.fn(async () => ({ ok: false })),
		cleanLatexAuxFiles: vi.fn(async () => ({ ok: true })),
	},
	events: new Proxy(
		{},
		{
			get: () => ({ listen: async () => () => {} }),
		},
	),
}));

vi.mock("@/lib/workspace/actions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/actions")>()),
	compileTexProject,
}));

const ROOT = "C:/vault/thesis/main.tex";
const i18n = i18next.createInstance();
let container: HTMLDivElement;
let root: Root;

function group() {
	const node = document.querySelector<HTMLElement>("[data-compile-state]");
	if (!node) throw new Error("compile control missing");
	return node;
}

function compileButton() {
	const button = group().querySelector("button");
	if (!button) throw new Error("compile button missing");
	return button;
}

function menuButton() {
	const button = document.querySelector<HTMLButtonElement>(
		'[aria-label="更多编译操作"]',
	);
	if (!button) throw new Error("compile menu missing");
	return button;
}

async function showBar() {
	await act(async () => {
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(WritingPdfBar, {
					rootFile: ROOT,
					livePreview: false,
					onLivePreviewChange: () => {},
				}),
			),
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	compileTexProject.mockClear();
	texCompileStore.setState({
		engines: [{ id: "xelatex", label: "XeLaTeX", path: "xelatex" }],
		enginesLoading: false,
		selectedEngine: "xelatex",
		compilingPath: null,
	});
	texBuildStore.setState({ byRoot: {}, dependencies: {} });
	if (!i18n.isInitialized) {
		await i18n.init({
			lng: "zh-CN",
			fallbackLng: "zh-CN",
			ns: ["sidebar", "latexBuild"],
			defaultNS: "sidebar",
			interpolation: { escapeValue: false },
			resources: {
				"zh-CN": { sidebar: zhSidebar, latexBuild: zhLatex },
			},
		});
	}
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await showBar();
});

afterEach(async () => {
	vi.useRealTimers();
	await act(async () => root.unmount());
	container.remove();
});

it("stays idle and clickable before the first compile", () => {
	expect(group().dataset.compileState).toBe("idle");
	expect(compileButton().textContent).toContain("编译");
	expect(compileButton().querySelector(".animate-spin")).toBeNull();
	expect(compileButton().disabled).toBe(false);
	expect(menuButton().disabled).toBe(false);
});

it("shows a solid compiling control, and ignores another click", async () => {
	await act(async () => {
		texCompileStore.setState({ compilingPath: `${ROOT}` });
	});
	expect(group().dataset.compileState).toBe("running");
	expect(group().getAttribute("aria-busy")).toBe("true");
	expect(compileButton().textContent).toContain("正在编译…");
	expect(compileButton().querySelector(".animate-spin")).not.toBeNull();
	expect(compileButton().disabled).toBe(true);
	expect(compileButton().className).toContain("disabled:opacity-100");
	expect(compileButton().className).not.toContain("disabled:opacity-50");
	expect(menuButton().disabled).toBe(false);

	compileButton().click();
	expect(compileTexProject).not.toHaveBeenCalled();
});

it("compiles a child source on this root without spinning another project", async () => {
	await act(async () => {
		texCompileStore.setState({
			compilingPath: "C:/vault/thesis/chapters/a.tex",
		});
	});
	expect(group().dataset.compileState).toBe("running");
});

it("flashes success, then returns to idle so the next click compiles again", async () => {
	await act(async () => {
		texCompileStore.setState({ compilingPath: ROOT });
		beginTexBuild(ROOT);
	});
	expect(group().dataset.compileState).toBe("running");

	vi.useFakeTimers();
	await act(async () => {
		finishTexBuild(ROOT, "succeeded");
		texCompileStore.setState({ compilingPath: null });
	});
	expect(group().dataset.compileState).toBe("succeeded");
	expect(compileButton().textContent).toContain("编译成功");
	expect(compileButton().querySelector(".animate-spin")).toBeNull();
	expect(compileButton().disabled).toBe(false);

	await act(async () => {
		vi.advanceTimersByTime(COMPILE_SUCCESS_FLASH_MS);
	});
	expect(group().dataset.compileState).toBe("idle");
	expect(compileButton().querySelector(".animate-spin")).toBeNull();

	compileButton().click();
	expect(compileTexProject).toHaveBeenCalledTimes(1);
	expect(compileTexProject).toHaveBeenCalledWith(ROOT);
});

it("returns to idle after failure and keeps the problems button red", async () => {
	await act(async () => {
		texCompileStore.setState({ compilingPath: ROOT });
		beginTexBuild(ROOT);
	});
	await act(async () => {
		finishTexBuild(ROOT, "failed", "latexmk not found");
		texCompileStore.setState({ compilingPath: null });
	});
	expect(group().dataset.compileState).toBe("idle");
	expect(compileButton().textContent).not.toContain("正在编译");
	expect(compileButton().querySelector(".animate-spin")).toBeNull();
	expect(compileButton().disabled).toBe(false);
	expect(document.querySelector("button.text-destructive")).not.toBeNull();

	compileButton().click();
	expect(compileTexProject).toHaveBeenCalledWith(ROOT);
});

it("returns to idle after cancel without a success flash", async () => {
	await act(async () => {
		texCompileStore.setState({ compilingPath: ROOT });
		beginTexBuild(ROOT);
		receiveTexLog({ rootPath: ROOT, jobId: "job-1", line: "running" });
	});
	await act(async () => {
		finishTexBuild(ROOT, "cancelled");
		texCompileStore.setState({ compilingPath: null });
	});
	expect(group().dataset.compileState).toBe("idle");
	expect(compileButton().textContent).not.toContain("编译成功");
	expect(compileButton().querySelector(".animate-spin")).toBeNull();

	compileButton().click();
	expect(compileTexProject).toHaveBeenCalledWith(ROOT);
});

it("disables the compile actions while leaving stop available", async () => {
	await act(async () => {
		texCompileStore.setState({ compilingPath: ROOT });
		beginTexBuild(ROOT);
		receiveTexLog({ rootPath: ROOT, jobId: "job-1", line: "running" });
	});
	await act(async () => {
		menuButton().dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true }),
		);
		menuButton().click();
	});
	const rebuild = [...document.querySelectorAll('[role="menuitem"]')].find(
		(item) => item.textContent?.includes("强制重新编译"),
	);
	const stop = [...document.querySelectorAll('[role="menuitem"]')].find(
		(item) => item.textContent?.includes("停止编译"),
	);
	expect(rebuild?.getAttribute("aria-disabled")).toBe("true");
	expect(stop?.getAttribute("aria-disabled")).not.toBe("true");
});

it("stays gray and still when no engine is installed", async () => {
	await act(async () => {
		texCompileStore.setState({ engines: [], enginesLoading: false });
	});
	expect(group().dataset.compileState).toBe("idle");
	expect(compileButton().disabled).toBe(true);
	expect(menuButton().disabled).toBe(true);
	expect(compileButton().querySelector(".animate-spin")).toBeNull();
	expect(compileButton().className).not.toContain("disabled:opacity-100");
	expect(compileButton().className).toContain("disabled:opacity-50");
});
