"use client";

import { KEYS, RangeApi } from "platejs";
import type { PlateEditor } from "platejs/react";
import {
	type Dispatch,
	type KeyboardEvent,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	SlashCommandController,
	SlashCommandDraft,
} from "@/components/editor/overlays/slash-command-menu";
import type {
	WikiCompletionController,
	WikiCompletionDraft,
} from "@/components/editor/overlays/wiki-link-suggestion";
import { findSlashCommandTrigger } from "@/lib/markdown/slash-command";
import { findWikiCompletionTrigger } from "@/lib/wiki-completion";

type CursorProbe = {
	/** Text of the leaf holding the collapsed caret. */
	text: string;
	offset: number;
	anchorPath: number[];
	/** Nearest element ancestor of the caret, for `code` / void exclusion. */
	anchorElement: Element;
	/**
	 * Caret rect, computed on first call and cached. Reading it forces layout,
	 * so only ask once a trigger is known to be live.
	 */
	getCursorRect: () => DOMRect;
};

/**
 * Locate the caret when it is collapsed inside an editable text leaf the editor
 * still owns. Callers decide which DOM regions disqualify it, so one probe can
 * serve both menus.
 */
function probeCursor(
	editor: PlateEditor,
	container: HTMLElement | null,
): CursorProbe | null {
	// A menu must not reopen once focus left the editor (e.g. moved to a toolbar).
	if (!container || !container.contains(document.activeElement)) return null;
	const slateSelection = editor.selection;
	if (!slateSelection || !RangeApi.isCollapsed(slateSelection)) return null;

	const leaf = editor.api.node(slateSelection.anchor.path)?.[0];
	if (!leaf || typeof (leaf as { text?: unknown }).text !== "string") {
		return null;
	}

	const nativeSelection = window.getSelection();
	const anchor = nativeSelection?.anchorNode;
	if (!nativeSelection?.isCollapsed || !anchor) return null;

	const anchorElement =
		anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : null;
	if (!anchorElement || !container.contains(anchorElement)) return null;
	if (!nativeSelection.rangeCount) return null;

	const range = nativeSelection.getRangeAt(0);
	let cursorRect: DOMRect | null = null;
	return {
		text: (leaf as { text: string }).text,
		offset: slateSelection.anchor.offset,
		anchorPath: [...slateSelection.anchor.path],
		anchorElement,
		getCursorRect: () => (cursorRect ??= range.getBoundingClientRect()),
	};
}

export type CompletionDrafts = {
	wikiCompletionDraft: WikiCompletionDraft | null;
	slashCommandDraft: SlashCommandDraft | null;
	setWikiCompletionDraft: Dispatch<SetStateAction<WikiCompletionDraft | null>>;
	setSlashCommandDraft: Dispatch<SetStateAction<SlashCommandDraft | null>>;
	/** Dismiss both menus (Escape, blur). */
	closeMenus: () => void;
	completionControllerRef: RefObject<WikiCompletionController | null>;
	slashCommandControllerRef: RefObject<SlashCommandController | null>;
	/**
	 * Re-probe both menus on the next frame, coalescing repeat calls within the
	 * same frame into one DOM measurement.
	 */
	scheduleCompletionProbe: () => void;
	/** True when an open menu consumed the key; the editor must not see it. */
	handleMenuKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean;
};

/**
 * The `[[wikilink]]` and `/slash` completion menus: where they anchor, and
 * which keys they own while open.
 *
 * Both menus are editor-side probes rather than full Plate plugins — the
 * suggestion components own their Host queries; this only finds the trigger.
 */
export function useCompletionDrafts({
	editor,
	editorContainerRef,
}: {
	editor: PlateEditor;
	editorContainerRef: RefObject<HTMLDivElement | null>;
}): CompletionDrafts {
	const [wikiCompletionDraft, setWikiCompletionDraft] =
		useState<WikiCompletionDraft | null>(null);
	const [slashCommandDraft, setSlashCommandDraft] =
		useState<SlashCommandDraft | null>(null);
	const wikiCompletionDraftRef = useRef(wikiCompletionDraft);
	wikiCompletionDraftRef.current = wikiCompletionDraft;
	const slashCommandDraftRef = useRef(slashCommandDraft);
	slashCommandDraftRef.current = slashCommandDraft;
	const completionControllerRef = useRef<WikiCompletionController | null>(null);
	const slashCommandControllerRef = useRef<SlashCommandController | null>(null);

	const probeFrameRef = useRef<number | null>(null);

	const refreshDrafts = useCallback(() => {
		const probe = probeCursor(editor, editorContainerRef.current);

		const wikiTrigger =
			probe && !probe.anchorElement.closest("code, pre")
				? findWikiCompletionTrigger(probe.text, probe.offset)
				: null;
		if (probe && wikiTrigger) {
			const rect = probe.getCursorRect();
			setWikiCompletionDraft({
				raw: wikiTrigger.raw,
				embed: wikiTrigger.embed,
				left: rect.left,
				top: rect.bottom + 4,
			});
		} else {
			setWikiCompletionDraft(null);
		}

		const slashTrigger =
			probe &&
			!probe.anchorElement.closest("code, pre, [data-slate-void='true']")
				? findSlashCommandTrigger(probe.text, probe.offset)
				: null;
		const block = slashTrigger ? editor.api.block() : null;
		if (probe && slashTrigger && block) {
			const rect = probe.getCursorRect();
			const insideCallout = Boolean(
				editor.api.above({ match: { type: editor.getType(KEYS.callout) } }),
			);
			setSlashCommandDraft({
				query: slashTrigger.query,
				path: probe.anchorPath,
				start: slashTrigger.start,
				end: slashTrigger.end,
				left: rect.left,
				top: rect.bottom + 4,
				allowCallout: block[1].length === 1 && !insideCallout,
			});
		} else {
			setSlashCommandDraft(null);
		}
	}, [editor, editorContainerRef]);

	const refreshDraftsRef = useRef(refreshDrafts);
	refreshDraftsRef.current = refreshDrafts;

	const scheduleCompletionProbe = useCallback(() => {
		if (probeFrameRef.current !== null) return;
		probeFrameRef.current = window.requestAnimationFrame(() => {
			probeFrameRef.current = null;
			refreshDraftsRef.current();
		});
	}, []);

	useEffect(
		() => () => {
			if (probeFrameRef.current !== null) {
				window.cancelAnimationFrame(probeFrameRef.current);
			}
		},
		[],
	);

	const handleMenuKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (completionControllerRef.current?.handleKeyDown(event)) return true;
			if (slashCommandControllerRef.current?.handleKeyDown(event)) return true;
			// If a menu is open but its controller is mid-remount, still swallow
			// vertical arrows so the caret cannot leave `[[` / `/`.
			if (
				(event.key === "ArrowUp" || event.key === "ArrowDown") &&
				(wikiCompletionDraftRef.current || slashCommandDraftRef.current)
			) {
				event.preventDefault();
				return true;
			}
			return false;
		},
		[],
	);

	const closeMenus = useCallback(() => {
		setWikiCompletionDraft(null);
		setSlashCommandDraft(null);
	}, []);

	return {
		wikiCompletionDraft,
		slashCommandDraft,
		setWikiCompletionDraft,
		setSlashCommandDraft,
		closeMenus,
		completionControllerRef,
		slashCommandControllerRef,
		scheduleCompletionProbe,
		handleMenuKeyDown,
	};
}
