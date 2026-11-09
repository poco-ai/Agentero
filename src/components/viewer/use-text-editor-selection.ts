/** CodeMirror adapter: supplies text, source lines and viewport coordinates to the shared host. */

import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import type { WritingSelectionGroup } from "@/components/writing/writing-selection-group";
import type { SelectionDraftScreen } from "@/lib/agent/selection-chat-store";
import {
	closeSelectionSource,
	dismissSelectionChat,
	openSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";
import {
	clearActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { basenameOf } from "@/lib/core/path";

export type TextEditorSelectionMenu = {
	text: string;
	screen: SelectionDraftScreen;
	/** 1-based selected line span — shown on the Agent context chip. */
	lineFrom: number;
	lineTo: number;
};

/** 1-based selected line span (`to` at a line start excludes that line). */
function selectionLines(
	doc: Text,
	selection: { from: number; to: number },
): { lineFrom: number; lineTo: number } {
	const first = doc.lineAt(selection.from).number;
	const endLine = doc.lineAt(selection.to);
	const last =
		endLine.number > first && endLine.from === selection.to
			? endLine.number - 1
			: endLine.number;
	return { lineFrom: first, lineTo: last };
}

/**
 * Toolbar anchor: top-center of the selection (top line's character center
 * for multi-line selections). `coordsAtPos` returns client coordinates —
 * exactly what the fixed-position `SelectionMenu` places by. Null when the
 * position is not rendered (scrolled out of the editor viewport).
 */
function selectionMenuScreen(view: EditorView): SelectionDraftScreen | null {
	const selection = view.state.selection.main;
	if (selection.empty) return null;
	const start = view.coordsAtPos(selection.from, -1);
	const end = view.coordsAtPos(selection.to, 1);
	if (!start) return null;
	const sameLine = end != null && Math.abs(end.top - start.top) < 1;
	const x =
		sameLine && end != null
			? (start.left + end.right) / 2
			: (start.left + start.right) / 2;
	const top = Math.min(start.top, end?.top ?? start.top);
	// Multi-line selections open cards below the last line, not just the first.
	const bottom = Math.max(start.bottom, end?.bottom ?? start.bottom);
	return {
		x,
		y: top,
		selectionBounds: {
			left: Math.min(start.left, end?.left ?? start.left),
			top,
			right: Math.max(start.right, end?.right ?? start.right),
			bottom,
		},
	};
}

export function useTextEditorSelection({
	viewRef,
	path,
	active,
	selectionGroup,
}: {
	/** CodeMirror view owned by TextEditor's mount effect. */
	viewRef: RefObject<EditorView | null>;
	/** Vault file path — provenance for ask threads and Agent chips. */
	path: string;
	/** Only the active tab may arm the toolbar (inactive panes stay mounted). */
	active: boolean;
	/** Writing split: keep source and PDF selections mutually exclusive. */
	selectionGroup?: WritingSelectionGroup | null;
}) {
	const menuRef = useRef<TextEditorSelectionMenu | null>(null);
	const ownedId = useRef<string | null>(null);
	const activeRef = useRef(active);
	activeRef.current = active;
	const pathRef = useRef(path);
	pathRef.current = path;

	// True while this surface owns the store's live "markdown" chip. Cleared
	// selectively so our empty-selection updates never drop a chip another
	// surface (Plate editor) published.
	const publishedRef = useRef(false);

	const hideMenu = useCallback(() => {
		menuRef.current = null;
		if (
			selectionChatStore.getState().draft?.selection.id === ownedId.current &&
			selectionChatStore.getState().draft?.stage === "menu"
		)
			dismissSelectionChat();
		if (publishedRef.current) {
			publishedRef.current = false;
			clearActiveSelection("markdown");
		}
	}, []);

	const armRef = useRef<(view: EditorView) => void>(() => undefined);
	armRef.current = (view: EditorView) => {
		const selection = view.state.selection.main;
		const text = selection.empty
			? ""
			: view.state.sliceDoc(selection.from, selection.to);
		if (!text.trim()) {
			hideMenu();
			return;
		}
		// Off-viewport selections cannot be anchored — keep the previous one.
		const screen = selectionMenuScreen(view);
		if (!screen) return;
		const { lineFrom, lineTo } = selectionLines(view.state.doc, selection);
		menuRef.current = { text, screen, lineFrom, lineTo };
		openSelectionChat(
			{
				text,
				sourcePath: pathRef.current,
				sourceTitle: basenameOf(pathRef.current),
				origin: "markdown",
				surface: "text",
				lineFrom,
				lineTo,
			},
			screen,
			"menu",
		);
		ownedId.current = selectionChatStore.getState().draft?.selection.id ?? null;
		publishedRef.current = true;
		selectionGroup?.announce("source");
		publishSelection({
			text,
			sourcePath: pathRef.current,
			origin: "markdown",
			lineFrom,
			lineTo,
		});
	};

	const mouseDownRef = useRef(false);

	/** Stable extension (registered once at TextEditor mount). */
	const selectionListener = useMemo(
		() =>
			EditorView.updateListener.of((update) => {
				if (!update.selectionSet) return;
				// Mid-drag sweeps wait for mouseup (the PDF arm point); keyboard
				// selections (⇧+arrows, double-click, ⌘A) arm right away.
				if (mouseDownRef.current || !activeRef.current) return;
				armRef.current(update.view);
			}),
		[],
	);

	// PDF selection took over the writing split: drop the source range, but do
	// not move the cursor or steal focus.
	useEffect(() => {
		if (!selectionGroup) return;
		return selectionGroup.subscribe((origin) => {
			if (origin !== "pdf") return;
			const view = viewRef.current;
			const selection = view?.state.selection.main;
			if (!view || !selection || selection.empty) return;
			view.dispatch({ selection: { anchor: selection.head } });
		});
	}, [selectionGroup, viewRef]);

	// Drag arm point + collapse dismissal: mousedown/mouseup pairs anywhere
	// (capture), arming only when the release lands inside this editor.
	useEffect(() => {
		const onDown = () => {
			mouseDownRef.current = true;
		};
		const onUp = (event: MouseEvent) => {
			mouseDownRef.current = false;
			const view = viewRef.current;
			if (!view || !activeRef.current) return;
			if (!(event.target instanceof Node) || !view.dom.contains(event.target))
				return;
			armRef.current(view);
		};
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("mouseup", onUp, true);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("mouseup", onUp, true);
		};
	}, [viewRef]);

	// Keep the toolbar glued to the selection while the editor scrolls.
	// Scroll events don't bubble, but capture still reaches window.
	// biome-ignore lint/correctness/useExhaustiveDependencies: viewRef is a stable ref; listener reads .current at event time
	useEffect(() => {
		const onScroll = () => {
			const current = menuRef.current;
			const view = viewRef.current;
			if (!current || !view || view.state.selection.main.empty) return;
			const screen = selectionMenuScreen(view);
			if (!screen) return; // off-viewport: SelectionMenu clamps + dims
			if (screen.x === current.screen.x && screen.y === current.screen.y)
				return;
			menuRef.current = { ...current, screen };
			const draft = selectionChatStore.getState().draft;
			if (draft?.stage === "menu" && draft.selection.id === ownedId.current)
				selectionChatStore.setState({ draft: { ...draft, screen } });
		};
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, []);

	// Leaving the tab dismisses the toolbar (the panel may be resized while
	// hidden, stranding the anchor); the shared host cancels transient requests.
	useEffect(() => {
		if (!active) {
			hideMenu();
			closeSelectionSource(path);
		}
	}, [active, hideMenu, path]);

	// Tab close / LRU eviction: drop the live chip this surface published.
	useEffect(() => {
		return () => {
			if (publishedRef.current) clearActiveSelection("markdown");
			closeSelectionSource(pathRef.current);
		};
	}, []);

	return { selectionListener };
}
