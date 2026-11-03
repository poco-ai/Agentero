/**
 * CodeMirror selection → floating chat toolbar for the plain-text editor.
 *
 * Same selection chrome the PDF / web-paper surfaces have, sourced from a
 * CodeMirror update-listener extension instead of a DOM selection: a
 * non-empty selection arms the shared `SelectionMenu` with Quick chat /
 * Add to chat only (text files have no marks/ sidecar, and no auto-copy —
 * silently replacing the clipboard mid-edit in a code buffer would destroy
 * the paste the selection is usually a prelude to). ⌘K opens the in-page
 * Ask popover; Add to chat opens an optional inline comment before pinning
 * the quote as an Agent composer chip. ⇧⌘L pins directly. Drag selections arm on mouse release (same as the PDF viewer);
 * keyboard selections arm immediately, and the toolbar re-anchors while
 * the editor scrolls.
 */

import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	createSelectionAskThread,
	useSelectionAsk,
} from "@/components/selection/use-selection-ask";
import { useSelectionQuickChat } from "@/components/selection/use-selection-quick-chat";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import type { WritingSelectionGroup } from "@/components/writing/writing-selection-group";
import { textAskContextRequest } from "@/lib/agent/context-request";
import { openSelectionChat } from "@/lib/agent/selection-chat-store";
import {
	clearActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { basenameOf } from "@/lib/core/path";
import { buildPlazaAskPrompt } from "@/lib/plaza/ask-prompt";

export type TextEditorSelectionMenu = {
	text: string;
	screen: ScreenPoint;
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
function selectionMenuScreen(view: EditorView): ScreenPoint | null {
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
	return { x, y: Math.min(start.top, end?.top ?? start.top) };
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
	const [menu, setMenu] = useState<TextEditorSelectionMenu | null>(null);
	const menuRef = useRef(menu);
	menuRef.current = menu;
	const activeRef = useRef(active);
	activeRef.current = active;
	const pathRef = useRef(path);
	pathRef.current = path;

	// Single in-flight agent run per editor, owned here for the ask cluster.
	const activeSessionRef = useRef<string | null>(null);

	const askCtl = useSelectionAsk<ScreenPoint>({
		buildPrompt: (thread, question) =>
			buildPlazaAskPrompt(thread, question, {
				title: basenameOf(pathRef.current),
				path: pathRef.current,
				surface: "text",
				omitLocatedQuote: true,
			}),
		context: (thread) => textAskContextRequest(thread, pathRef.current),
		activeSessionRef,
	});
	const { ask, setAsk } = askCtl;

	// True while this surface owns the store's live "markdown" chip. Cleared
	// selectively so our empty-selection updates never drop a chip another
	// surface (Plate editor) published.
	const publishedRef = useRef(false);

	const hideMenu = useCallback(() => {
		setMenu(null);
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
		setMenu({ text, screen, lineFrom, lineTo });
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

	const handleAsk = useCallback(() => {
		const current = menuRef.current;
		if (!current) return;
		const { text, screen } = current;
		setMenu(null);
		// Keep the editor selection + live chip armed while asking, mirroring
		// the PDF surface (⇧⌘L pins the quote mid-ask).
		setAsk({
			thread: createSelectionAskThread(pathRef.current, text),
			screen,
		});
	}, [setAsk]);

	const handleAddToChat = useCallback(() => {
		const current = menuRef.current;
		if (!current) return;
		setMenu(null);
		openSelectionChat(
			{
				text: current.text,
				sourcePath: pathRef.current,
				origin: "markdown",
				lineFrom: current.lineFrom,
				lineTo: current.lineTo,
			},
			current.screen,
		);
		// Collapse the selection so the toolbar does not re-arm when the editor
		// regains focus; the update listener drops the live chip while the
		// independent comment draft retains its quote and line range.
		const view = viewRef.current;
		const selection = view?.state.selection.main;
		if (view && selection && !selection.empty) {
			view.dispatch({ selection: { anchor: selection.head } });
		}
	}, [viewRef]);

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

	// ⌘K Quick chat — while this editor's selection toolbar is armed.
	useSelectionQuickChat(() => menuRef.current != null, handleAsk);

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
			setMenu({ ...current, screen });
		};
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, []);

	// Leaving the tab dismisses the toolbar (the panel may be resized while
	// hidden, stranding the anchor); the Ask thread keeps streaming.
	useEffect(() => {
		if (!active) hideMenu();
	}, [active, hideMenu]);

	// Tab close / LRU eviction: drop the live chip this surface published.
	useEffect(() => {
		return () => {
			if (publishedRef.current) clearActiveSelection("markdown");
		};
	}, []);

	return {
		/** Add to TextEditor's mount-once extension array. */
		selectionListener,
		menu,
		handleAsk,
		handleAddToChat,
		ask,
		streaming: askCtl.streaming,
		askError: askCtl.askError,
		sendAskQuestion: askCtl.sendAskQuestion,
		resendAskQuestion: askCtl.resendAskQuestion,
		hideAsk: askCtl.hideAsk,
		deleteAsk: askCtl.deleteAsk,
		stopAskStreaming: askCtl.stopAskStreaming,
	};
}
