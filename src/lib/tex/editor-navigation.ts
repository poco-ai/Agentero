import type { EditorView } from "@codemirror/view";
import { normalizePath } from "@/lib/core/path";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault/path";
import { vaultStore } from "@/lib/vault/store";
import { writingStore } from "@/lib/writing/store";

export type TexSourcePoint = { line: number; column: number };
export type TexEditorCursor = TexSourcePoint & { path: string };

type EditorRegistration = {
	path: string;
	view: EditorView;
	activate?: () => void;
	canonical: boolean;
	owner: "reading" | "writing";
	lastFocused: number;
};
const editors = new Map<string, Set<EditorRegistration>>();
const pending = new Map<string, { line: number; column: number }>();
let lastActiveEditor: EditorRegistration | null = null;
let focusOrder = 0;

function remember(editor: EditorRegistration): void {
	editor.lastFocused = ++focusOrder;
	if (/\.tex$/i.test(editor.path)) lastActiveEditor = editor;
}

function editorForPath(path: string): EditorRegistration | undefined {
	const entries = candidates(normalizePath(path));
	const focused = entries.find((entry) => entry.view.hasFocus);
	if (focused) {
		remember(focused);
		return focused;
	}
	return (
		entries
			.filter((entry) => entry.lastFocused > 0)
			.sort((a, b) => b.lastFocused - a.lastFocused)[0] ??
		entries.find((entry) => entry.canonical) ??
		entries[0]
	);
}

function candidates(key: string): EditorRegistration[] {
	const entries = [...(editors.get(key) ?? [])];
	const writing = writingStore.getState().surface === "writing";
	const preferred = entries.filter((entry) =>
		writing ? entry.owner === "writing" : entry.owner !== "writing",
	);
	if (writing) return preferred;
	return preferred.length > 0 ? preferred : entries;
}

export function markTexEditorActive(path: string, view?: EditorView): void {
	const editor = view
		? [...(editors.get(normalizePath(path)) ?? [])].find(
				(entry) => entry.view === view,
			)
		: editorForPath(path);
	if (editor) remember(editor);
}

function jump(editor: EditorRegistration, line: number, column: number): void {
	const { view } = editor;
	editor.activate?.();
	const target = view.state.doc.line(
		Math.min(Math.max(1, line), view.state.doc.lines),
	);
	const pos = Math.min(target.to, target.from + Math.max(0, column - 1));
	view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
	view.focus();
	remember(editor);
}

export function registerTexEditor(
	path: string,
	view: EditorView,
	options?: {
		activate?: () => void;
		canonical?: boolean;
		owner?: "reading" | "writing";
	},
): () => void {
	const key = normalizePath(path);
	const owner: EditorRegistration = {
		path,
		view,
		activate: options?.activate,
		canonical: options?.canonical !== false,
		owner: options?.owner ?? "reading",
		lastFocused: 0,
	};
	const entries = editors.get(key) ?? new Set<EditorRegistration>();
	entries.add(owner);
	editors.set(key, entries);
	if (view.hasFocus) remember(owner);
	const target = pending.get(key);
	if (target && owner.canonical) {
		pending.delete(key);
		jump(owner, target.line, target.column);
	}
	return () => {
		entries.delete(owner);
		if (!entries.size && editors.get(key) === entries) editors.delete(key);
		if (lastActiveEditor === owner) {
			lastActiveEditor =
				[...editors.values()]
					.flatMap((registered) => [...registered])
					.filter(
						(entry) => /\.tex$/i.test(entry.path) && entry.lastFocused > 0,
					)
					.sort((a, b) => b.lastFocused - a.lastFocused)[0] ?? null;
		}
	};
}

export function getTexEditorCursor(path?: string): TexEditorCursor | null {
	const focused = path
		? undefined
		: [...editors.values()]
				.flatMap((registered) => [...registered])
				.find((entry) => /\.tex$/i.test(entry.path) && entry.view.hasFocus);
	if (focused) remember(focused);
	const editor = path ? editorForPath(path) : (focused ?? lastActiveEditor);
	if (!editor) return null;
	const pos = editor.view.state.selection.main.head;
	const line = editor.view.state.doc.lineAt(pos);
	return {
		path: editor.path,
		line: line.number,
		column: pos - line.from + 1,
	};
}

export function getTexEditor(path: string): EditorView | null {
	return editorForPath(path)?.view ?? null;
}

/** Reuse the selected source pane; new opens wait specifically for its canonical view. */
export function navigateTexSource(
	path: string,
	line: number,
	column = 1,
): void {
	const key = normalizePath(path);
	const editor = editorForPath(path);
	if (editor) {
		pending.delete(key);
		jump(editor, line, column);
		return;
	}
	const request = { line, column };
	pending.set(key, request);
	void import("@/lib/workspace/navigation").then((nav) => {
		if (pending.get(key) !== request) return;
		if (isThesisPath(path)) {
			// A writing project owns one panel: swap its source pane in place
			// and let the newly mounted editor consume the pending jump.
			void nav.openWritingSourceAt(path);
			return;
		}
		nav.openTab(path, { preferMode: "text" });
		const canonical = [...(editors.get(key) ?? [])].find(
			(entry) => entry.canonical,
		);
		if (canonical && pending.get(key) === request) {
			pending.delete(key);
			jump(canonical, line, column);
		}
	});
}

const WRITING_SOURCE = /\.(?:tex|bib|sty|cls|bst)$/i;

/** Vault-relative `thesis/` membership, separator-agnostic. */
function isThesisPath(path: string): boolean {
	const vaultPath = vaultStore.getState().vaultPath;
	if (!vaultPath) return false;
	const rel =
		vaultRelativePath(vaultPath, path) ??
		path.replace(/\\/g, "/").replace(/^\.\//, "");
	return rel.replace(/\\/g, "/").toLowerCase().startsWith("thesis/");
}

function fragmentLine(fragment: string): number | null {
	const match = fragment.match(/^(?:line=)?L?(\d+)$/i);
	if (!match) return null;
	const line = Number(match[1]);
	return Number.isFinite(line) && line > 0 ? line : null;
}

/**
 * Agent citations of a manuscript source open in the writing project panel.
 * Papers and PDFs keep the reading jump.
 */
export function tryOpenWritingSource(path: string, fragment: string): boolean {
	const vaultPath = vaultStore.getState().vaultPath;
	if (!vaultPath) return false;
	const rel =
		vaultRelativePath(vaultPath, path) ??
		path.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!rel.replace(/\\/g, "/").toLowerCase().startsWith("thesis/"))
		return false;
	if (!WRITING_SOURCE.test(rel) || rel.split("/").includes("..")) return false;
	const full = joinVaultPath(vaultPath, rel);
	const line = fragmentLine(fragment);
	if (line) {
		navigateTexSource(full, line);
		return true;
	}
	void import("@/lib/workspace/navigation").then(({ openWritingSourceAt }) => {
		void openWritingSourceAt(full);
	});
	return true;
}
