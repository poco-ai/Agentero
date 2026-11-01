// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueTaskSettledMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/core/bindings", () => ({
	commands: {
		detectLatexEngines: vi.fn(async () => ({
			ok: true,
			data: [{ id: "xelatex", label: "XeLaTeX", path: "/usr/bin/xelatex" }],
		})),
	},
}));

vi.mock("@/lib/tex/auto-build", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tex/auto-build")>()),
	startTexAutoBuild: vi.fn(),
}));

vi.mock("@/lib/core/tasks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/core/tasks")>()),
	enqueueTaskSettled: enqueueTaskSettledMock,
}));

vi.mock("@/lib/vault/fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault/fs")>()),
	readVaultFile: vi.fn(async () => "documentclass{article}"),
}));

vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifySuccess: vi.fn(),
	notifyUndo: vi.fn(),
	notifyWarning: vi.fn(),
}));

// Only the project view's own effect is under test; its panes render nothing.
vi.mock("@/components/ui/resizable", () => ({
	ResizableGroup: ({ children }: { children: ReactNode }) => children,
	ResizablePanel: ({ children }: { children: ReactNode }) => children,
	ResizableHandle: () => null,
}));
vi.mock("@/components/writing/writing-desk", () => ({
	ProjectPdf: () => null,
}));
vi.mock("@/components/writing/writing-pdf-bar", () => ({
	WritingPdfBar: () => null,
}));
vi.mock("@/components/writing/writing-sync-buttons", () => ({
	WritingSyncButtons: () => null,
}));
vi.mock("@/hooks/use-tex-root", () => ({
	useTexRoot: (path: string | null) => path,
}));

import { TexProjectView } from "@/components/writing/tex-project-view";
import { notifyError } from "@/lib/core/notify";
import { texBuildStore } from "@/lib/tex/build-state";
// Import after the mocks: compileTexFile runs through mocked barrels.
import { compileTexFile, texCompileStore } from "@/lib/workspace/tex-compile";

const ROOT = "/Users/philfan/l/paper/thesis/main.tex";
const OTHER = "/Users/philfan/l/paper/other/main.tex";

let root: Root;
let container: HTMLDivElement;

/** Render the TeX project view of `projectRoot`, focused or not. */
function showProject(projectRoot: string, active: boolean) {
	return act(async () =>
		root.render(
			createElement(TexProjectView, {
				sourcePath: projectRoot,
				projectRoot,
				vaultPath: "/Users/philfan/l",
				active,
				panelId: "tab-main",
				// biome-ignore lint/correctness/noChildrenProp: required by TexProjectView's props
				children: null,
			}),
		),
	);
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.mocked(notifyError).mockClear();
	enqueueTaskSettledMock
		.mockReset()
		.mockRejectedValue(new Error("Undefined control sequence"));
	texCompileStore.setState({ compilingPath: null });
	texBuildStore.setState({ byRoot: {}, dependencies: {} });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("compileTexFile failure reporting", () => {
	it("toasts the failure when no project view shows the root", async () => {
		expect(await compileTexFile(ROOT)).toBeNull();

		expect(notifyError).toHaveBeenCalledWith("Undefined control sequence");
		expect(texBuildStore.getState().byRoot[ROOT]?.status).toBe("failed");
	});

	it("leaves the failure to the problems button of the focused project view", async () => {
		await showProject(ROOT, true);

		expect(await compileTexFile(ROOT)).toBeNull();

		expect(notifyError).not.toHaveBeenCalled();
		const snapshot = texBuildStore.getState().byRoot[ROOT];
		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				message: "Undefined control sequence",
			}),
		);
	});

	it("still toasts when the focused project view shows another root", async () => {
		await showProject(OTHER, true);

		await compileTexFile(ROOT);

		expect(notifyError).toHaveBeenCalledTimes(1);
	});

	it("toasts again once the project view loses focus or closes", async () => {
		await showProject(ROOT, true);
		await showProject(ROOT, false);
		await compileTexFile(ROOT);
		expect(notifyError).toHaveBeenCalledTimes(1);

		await showProject(ROOT, true);
		await act(async () => root.render(null));
		await compileTexFile(ROOT);
		expect(notifyError).toHaveBeenCalledTimes(2);
	});
});
