// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoveDestinationPicker } from "@/components/sidebar/file-tree/move-destination-picker";
import {
	TreeCreateInput,
	TreeRenameInput,
} from "@/components/sidebar/file-tree/tree-inputs";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { IME_COMPOSITION_END_GRACE_MS } from "@/lib/core/ime";

vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({
		t: (key: string) =>
			key === "fileTree.untitledTable" ? "Untitled table" : key,
	}),
}));

vi.mock("@/lib/vault", async () => import("@/lib/vault/path"));
vi.mock("@/hooks/use-papers-org-folders", () => ({
	usePapersOrgFolders: () => ["papers"],
}));

type Mode = "rename" | "file" | "directory" | "table" | "move";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers({
		toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
	});
	vi.advanceTimersByTime(1000);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function mount(mode: Mode) {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	const onOpenChange = vi.fn();
	function MoveFixture() {
		const [newFolder, setNewFolder] = useState("");
		return createElement(
			Popover,
			{ defaultOpen: true, onOpenChange },
			createElement(PopoverTrigger, null, "Move"),
			createElement(MoveDestinationPicker, {
				vaultPath: "/vault",
				nodes: [],
				sourcePaths: ["/vault/papers/old"],
				selectedFolder: "papers",
				newFolder,
				busy: false,
				onNewFolderChange: setNewFolder,
				onConfirm,
			}),
		);
	}
	await act(() => {
		root.render(
			mode === "move"
				? createElement(MoveFixture)
				: mode === "rename"
					? createElement(TreeRenameInput, {
							initialName: "old.md",
							icon: null,
							onConfirm,
							onCancel,
						})
					: createElement(TreeCreateInput, {
							kind: mode,
							onConfirm,
							onCancel,
						}),
		);
	});
	const input = document.querySelector("input");
	if (!input) throw new Error("Missing name input");
	return { input, onConfirm, onCancel, onOpenChange };
}

async function type(input: HTMLInputElement, value: string) {
	await act(() => {
		// Bypass React's value tracker to simulate a native input update.
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function key(input: HTMLInputElement, key: string, init = {}) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	await act(() => {
		input.dispatchEvent(event);
	});
	return event;
}

async function compose(input: HTMLInputElement, phase: "start" | "end") {
	await act(() => {
		input.dispatchEvent(
			new CompositionEvent(`composition${phase}`, { bubbles: true }),
		);
	});
}

async function finishGrace() {
	await act(() => vi.advanceTimersByTime(IME_COMPOSITION_END_GRACE_MS + 1));
}

describe.each<Mode>([
	"rename",
	"file",
	"directory",
	"move",
])("%s name input", (mode) => {
	it("lets the IME handle Enter and Escape, then submits the completed name", async () => {
		const { input, onConfirm, onCancel, onOpenChange } = await mount(mode);
		await compose(input, "start");
		await type(input, "文件");
		for (const name of ["Enter", "Escape"]) {
			const event = await key(input, name, { isComposing: true });
			// The move popover prevents Escape dismissal in its capture handler.
			if (mode !== "move" || name !== "Escape")
				expect(event.defaultPrevented).toBe(false);
		}
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
		await compose(input, "end");
		// WebKit can deliver the confirming key after compositionend.
		await key(input, "Enter");
		await key(input, "Escape");
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
		await finishGrace();
		await type(input, "文件名称");
		await key(input, "Enter");
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
			mode === "move"
				? "papers/文件名称"
				: mode === "file"
					? "文件名称.md"
					: "文件名称",
		);
	});

	it("ignores IME keyCode 229 even when isComposing is false", async () => {
		const { input, onConfirm, onCancel } = await mount(mode);
		await type(input, "文件");
		await key(input, "Enter", { keyCode: 229 });
		await key(input, "Escape", { keyCode: 229 });
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("keeps ordinary Escape working", async () => {
		const { input, onCancel, onOpenChange } = await mount(mode);
		await key(input, "Escape");
		if (mode === "move") expect(onOpenChange).toHaveBeenCalledWith(false);
		else expect(onCancel).toHaveBeenCalledOnce();
	});
});

describe.each<Mode>([
	"rename",
	"file",
	"directory",
])("%s inline name input", (mode) => {
	it("submits the final composition value on blur exactly once", async () => {
		const { input, onConfirm } = await mount(mode);
		await compose(input, "start");
		await type(input, "文件");
		await act(() => {
			input.blur();
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "文件名称");
			input.dispatchEvent(
				new CompositionEvent("compositionend", { bubbles: true }),
			);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await finishGrace();
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
			mode === "file" ? "文件名称.md" : "文件名称",
		);
		await key(input, "Enter");
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
			mode === "file" ? "文件名称.md" : "文件名称",
		);
	});

	it("does not submit twice when Enter is followed by blur", async () => {
		const { input, onConfirm } = await mount(mode);
		await type(input, "new-name");
		await key(input, "Enter");
		await act(() => input.blur());
		await finishGrace();
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
			mode === "file" ? "new-name.md" : "new-name",
		);
	});

	it("keeps invalid names editable and cancels empty names", async () => {
		const { input, onConfirm, onCancel } = await mount(mode);
		await type(input, "invalid/name");
		await key(input, "Enter");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(onConfirm).not.toHaveBeenCalled();
		await type(input, " ");
		await key(input, "Enter");
		expect(onCancel).toHaveBeenCalledOnce();
	});
});

it("preserves initial selection and unchanged-name behavior", async () => {
	const { input, onConfirm, onCancel } = await mount("rename");
	expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
	await key(input, "Enter");
	expect(onCancel).toHaveBeenCalledOnce();
	expect(onConfirm).not.toHaveBeenCalled();
});

it("selects the new file basename while keeping the Markdown suffix", async () => {
	const { input } = await mount("file");
	expect(input.getAttribute("aria-label")).toBe("fileTree.newFile");
	expect(input.value).toBe("fileTree.untitledNote.md");
	expect([input.selectionStart, input.selectionEnd]).toEqual([0, 21]);
});

it("starts a research table from a human name and appends .table.json", async () => {
	const { input, onConfirm } = await mount("table");
	expect(input.getAttribute("aria-label")).toBe("newTableLabel");
	expect(input.value).toBe("Untitled table");
	expect([input.selectionStart, input.selectionEnd]).toEqual([
		0,
		input.value.length,
	]);
	await key(input, "Enter");
	expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
		"Untitled table.table.json",
	);
});

it.each([
	["循环结果", "循环结果.table.json"],
	["results.table.json", "results.table.json"],
	["results.TABLE.JSON", "results.TABLE.JSON"],
	["results.json", "results.table.json"],
])("creates research table %s as %s", async (name, expected) => {
	const { input, onConfirm } = await mount("table");
	await type(input, name);
	await key(input, "Enter");
	expect(onConfirm).toHaveBeenCalledExactlyOnceWith(expected);
});

it.each([
	["读书笔记", "读书笔记.md"],
	["note.md", "note.md"],
	["note.MD", "note.MD"],
	["note.txt", "note.txt"],
])("creates %s as %s", async (name, expected) => {
	const { input, onConfirm } = await mount("file");
	await type(input, name);
	await key(input, "Enter");
	expect(onConfirm).toHaveBeenCalledExactlyOnceWith(expected);
});
