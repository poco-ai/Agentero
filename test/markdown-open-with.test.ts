// @vitest-environment happy-dom

import { createInstance } from "i18next";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownDocProvider } from "@/components/editor/context/markdown-doc-context";
import {
	MarkdownOpenWithButton,
	noteShowsOpenWith,
} from "@/components/editor/toolbar/markdown-open-with";
import { MarkdownDocTrailingActions } from "@/components/editor/toolbar/markdown-toolbar";
import { Toolbar } from "@/components/editor/toolbar/primitives";
import { TooltipProvider } from "@/components/ui/tooltip";
import { libraryStore } from "@/lib/paper/library-store";
import type { PaperMetadata } from "@/lib/paper/types";
import { WikiNavContext } from "@/lib/wiki/nav-context";

vi.mock("@/lib/system/open-with", () => ({
	probeOpenWithApps: async () => [],
	openPaperFolderWith: async () => {},
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
		{};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
		.__TAURI_INTERNALS__;
	vi.unstubAllGlobals();
});

async function renderNote(
	filePath: string | null,
	vaultPath: string | null,
	trailing = false,
): Promise<void> {
	const i18n = createInstance();
	await i18n.init({ lng: "en", resources: {} });
	const wrap = (children: ReactNode) =>
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(
				MarkdownDocProvider,
				{ value: { filePath } },
				createElement(
					WikiNavContext.Provider,
					{
						value: {
							onWikiNavigate: () => {},
							vaultPath,
						},
					},
					children,
				),
			),
		);
	await act(async () => {
		root.render(
			wrap(
				createElement(
					TooltipProvider,
					null,
					createElement(
						Toolbar,
						null,
						createElement(
							trailing ? MarkdownDocTrailingActions : MarkdownOpenWithButton,
						),
					),
				),
			),
		);
	});
}

const buttonLabels = () =>
	[...container.querySelectorAll("button")].map((button) =>
		button.getAttribute("aria-label"),
	);

describe("note open-with control", () => {
	it("shows the split control for a local note", async () => {
		await renderNote("/vault/notes/idea.md", "/vault");
		expect(buttonLabels()).toEqual(["pathBar.openFolder", "pathBar.openWith"]);
	});

	it("stays hidden for virtual and remote notes", async () => {
		await renderNote("agentero:note", "/vault");
		expect(container.querySelectorAll("button")).toHaveLength(0);
		await renderNote("/vault/notes/idea.md", "remote:session-1");
		expect(container.querySelectorAll("button")).toHaveLength(0);
		await renderNote("remote:session-1/notes/idea.md", null);
		expect(container.querySelectorAll("button")).toHaveLength(0);
	});

	it("re-checks the visibility predicate independently of the DOM", () => {
		expect(noteShowsOpenWith("/vault/notes/idea.md", "/vault")).toBe(true);
		expect(noteShowsOpenWith("/vault/notes/idea.md", "remote:s1")).toBe(false);
		expect(noteShowsOpenWith("remote:s1/notes/idea.md", null)).toBe(false);
		expect(noteShowsOpenWith("agentero:note", "/vault")).toBe(false);
		expect(noteShowsOpenWith(null, "/vault")).toBe(false);
	});

	it("keeps the Cool Papers action on a catalogued paper NOTES.md", async () => {
		libraryStore.setState({
			paperMetaByRelPath: new Map([
				["papers/atlas", { id: "atlas", title: "Atlas" } as PaperMetadata],
			]),
		});
		await renderNote("/vault/papers/atlas/NOTES.md", "/vault", true);
		expect(
			container.querySelector("[data-fetch-cool-papers-notes]"),
		).not.toBeNull();
		expect(buttonLabels()).not.toContain("pathBar.openWith");
	});

	it("uses open-with on an ordinary note instead of the notes action", async () => {
		libraryStore.setState({ paperMetaByRelPath: new Map() });
		await renderNote("/vault/notes/idea.md", "/vault", true);
		expect(
			container.querySelector("[data-fetch-cool-papers-notes]"),
		).toBeNull();
		expect(buttonLabels()).toContain("pathBar.openWith");
	});
});
