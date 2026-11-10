// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FileTree,
	FileTreeFile,
	FileTreeFolderRow,
} from "@/components/sidebar/file-tree/file-tree-primitives";
import { forwardListVimKey } from "@/lib/keyboard/list-vim-keys";

(
	globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const press = (key: string) => ({
	key,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
});

let container: HTMLDivElement;
let root: Root;
let selected: string[];
let expandedChanges: string[][];

function rows(): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]"));
}

function stubRects() {
	for (const row of rows()) {
		const rect = new DOMRect(0, 0, 200, 28);
		row.getBoundingClientRect = () => rect;
		Object.defineProperty(row, "getClientRects", { value: () => [rect] });
	}
}

function pressVim(key: string) {
	act(() => {
		forwardListVimKey(press(key), document);
	});
}

describe("file tree vim keys", () => {
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		selected = [];
		expandedChanges = [];
		root = createRoot(container);
		act(() => {
			root.render(
				createElement(
					FileTree,
					{
						defaultExpanded: new Set(["docs"]),
						selectedPath: null,
						onSelect: (path: string) => selected.push(path),
						onExpandedChange: (next: Set<string>) =>
							expandedChanges.push([...next]),
					},
					createElement(FileTreeFolderRow, {
						key: "docs",
						path: "docs",
						name: "Docs",
					}),
					createElement(FileTreeFile, {
						key: "a",
						path: "docs/a.md",
						name: "A",
					}),
				),
			);
		});
		stubRects();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("walks rows with j/k and selects the focused row", () => {
		const [docs, file] = rows();
		docs.focus();
		pressVim("j");
		expect(document.activeElement).toBe(file);
		expect(selected).toEqual(["docs/a.md"]);
		pressVim("k");
		expect(document.activeElement).toBe(docs);
		expect(selected).toEqual(["docs/a.md", "docs"]);
	});

	it("enters the first child with l and returns to the parent with h", () => {
		const [docs, file] = rows();
		docs.focus();
		pressVim("l");
		expect(document.activeElement).toBe(file);
		pressVim("h");
		expect(document.activeElement).toBe(docs);
	});

	it("collapses with h and expands with l instead of jumping rows", () => {
		const [docs] = rows();
		docs.focus();
		pressVim("h");
		expect(expandedChanges).toEqual([[]]);
		expect(document.activeElement).toBe(docs);

		pressVim("l");
		expect(expandedChanges).toEqual([[], ["docs"]]);
		expect(document.activeElement).toBe(docs);
	});
});
