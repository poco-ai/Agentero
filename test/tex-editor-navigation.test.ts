import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/workspace/navigation", () => ({ openTab: mocks.open }));

import {
	getTexEditor,
	getTexEditorCursor,
	markTexEditorActive,
	navigateTexSource,
	registerTexEditor,
} from "@/lib/tex/editor-navigation";

const path = "/vault/main.tex";
const cleanup: (() => void)[] = [];

function editor(position: number, focused: boolean) {
	const fixture = {
		hasFocus: focused,
		state: EditorState.create({
			doc: "first\nsecond\nthird",
			selection: { anchor: position },
		}),
		dispatch: vi.fn((spec: TransactionSpec) => {
			fixture.state = fixture.state.update(spec).state;
		}),
		focus: vi.fn(() => {
			fixture.hasFocus = true;
		}),
	};
	return { fixture, view: fixture as unknown as EditorView };
}

afterEach(() => {
	for (const unregister of cleanup.splice(0)) unregister();
	mocks.open.mockClear();
});

describe("TeX source editor pane registry", () => {
	it("reads the focused clone even when another clone registered later", () => {
		const first = editor(0, true);
		const second = editor(13, false);
		cleanup.push(
			registerTexEditor(path, first.view),
			registerTexEditor(path, second.view),
		);
		markTexEditorActive(path);
		expect(getTexEditorCursor()).toEqual({ path, line: 1, column: 1 });
		expect(getTexEditor(path)).toBe(first.view);
	});

	it("remembers the exact last-focused view when focus moves to a toolbar", () => {
		const first = editor(1, true);
		const second = editor(14, false);
		cleanup.push(
			registerTexEditor(path, first.view),
			registerTexEditor(path, second.view),
		);
		markTexEditorActive(path, first.view);
		first.fixture.hasFocus = false;
		expect(getTexEditorCursor()).toEqual({ path, line: 1, column: 2 });
		second.fixture.hasFocus = true;
		markTexEditorActive(path, second.view);
		second.fixture.hasFocus = false;
		expect(getTexEditorCursor(path)).toEqual({ path, line: 3, column: 2 });
		expect(getTexEditorCursor()).toEqual({ path, line: 3, column: 2 });
	});

	it("activates and jumps the same selected clone without opening a different canonical pane", () => {
		const first = editor(0, true);
		const second = editor(13, false);
		const activateFirst = vi.fn();
		const activateSecond = vi.fn();
		cleanup.push(
			registerTexEditor(path, first.view, {
				activate: activateFirst,
				canonical: false,
			}),
			registerTexEditor(path, second.view, { activate: activateSecond }),
		);
		markTexEditorActive(path, first.view);
		first.fixture.hasFocus = false;
		navigateTexSource(path, 2, 3);
		expect(activateFirst).toHaveBeenCalledOnce();
		expect(activateSecond).not.toHaveBeenCalled();
		expect(first.fixture.state.selection.main.head).toBe(8);
		expect(second.fixture.dispatch).not.toHaveBeenCalled();
		expect(mocks.open).not.toHaveBeenCalled();
	});

	it("retains surviving registrations when a sibling pane unmounts", () => {
		const first = editor(0, true);
		const second = editor(13, false);
		const unregisterFirst = registerTexEditor(path, first.view);
		cleanup.push(unregisterFirst, registerTexEditor(path, second.view));
		unregisterFirst();
		expect(getTexEditor(path)).toBe(second.view);
		navigateTexSource(path, 2);
		expect(second.fixture.state.selection.main.head).toBe(6);
	});

	it("waits for the newly opened canonical pane rather than consuming its jump in a mounting clone", async () => {
		navigateTexSource(path, 3, 2);
		await vi.waitFor(() =>
			expect(mocks.open).toHaveBeenCalledWith(path, { preferMode: "text" }),
		);
		const clone = editor(0, false);
		const canonical = editor(0, false);
		const activateCanonical = vi.fn();
		cleanup.push(
			registerTexEditor(path, clone.view, { canonical: false }),
			registerTexEditor(path, canonical.view, { activate: activateCanonical }),
		);
		expect(clone.fixture.dispatch).not.toHaveBeenCalled();
		expect(canonical.fixture.state.selection.main.head).toBe(14);
		expect(activateCanonical).toHaveBeenCalledOnce();
	});
});
