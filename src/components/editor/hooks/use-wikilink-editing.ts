"use client";

import { RangeApi } from "platejs";
import type { PlateEditor } from "platejs/react";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
} from "react";
import {
	isWikiLinkDraftEditingOffset,
	isWikiLinkDraftText,
	isWikiLinkNode,
	parseWikiLinkMarkdown,
	wikiLinkDraftEditableBounds,
	wikiLinkDraftExteriorPlacement,
	wikiLinkNodeMatchesSource,
	wikiLinkNodeSource,
	wikiLinkToMarkdown,
} from "@/lib/wiki/wikilink-model";
import { wikiLinkArrowDirection } from "@/lib/wiki-completion";

type WikiLinkExteriorBoundary = {
	path: number[];
	placement: "before" | "after";
	embed: boolean;
	source: "draft" | "stable" | "display";
};

export type WikilinkEditing = {
	/** Re-project every wikilink node for the given selection. */
	syncWikiLinkPresentation: (selection: PlateEditor["selection"]) => void;
	scheduleWikiLinkPresentationSync: () => void;
	/**
	 * Markdown snapshot taken just before a presentation-only edit, cleared on
	 * read. A value change matching it is projection, not a user edit.
	 */
	consumePresentationMarkdown: () => string | null;
	handleWikiLinkBoundaryBeforeInput: (event: FormEvent<HTMLDivElement>) => void;
	handleWikiLinkArrow: (event: KeyboardEvent<HTMLDivElement>) => boolean;
	handleWikiLinkBoundaryDelete: (
		event: KeyboardEvent<HTMLDivElement>,
	) => boolean;
	handleWikiLinkDraftEnter: (event: KeyboardEvent<HTMLDivElement>) => boolean;
	handleWikiLinkCompositionStart: () => void;
	handleWikiLinkCompositionEnd: () => void;
	/** Reify complete drafts, drop the marker from unfinished ones. */
	finalizeWikiLinkDrafts: () => void;
};

/**
 * Editing semantics for the inline `[[wikilink]]` / `![[embed]]` node.
 *
 * The node's text child owns the portable source syntax; selection only changes
 * how the component projects it. That projection is what makes caret movement,
 * deletion and IME composition at the node boundary need explicit handling —
 * the visible text and the source text differ in length.
 */
export function useWikilinkEditing({
	editor,
	serialize,
	suppressNextEditorBreakRef,
}: {
	editor: PlateEditor;
	serialize: () => string;
	/** Swallow the `beforeinput` insertParagraph that follows slash Enter confirm. */
	suppressNextEditorBreakRef: RefObject<boolean>;
}): WikilinkEditing {
	const syncingWikiLinkPresentationRef = useRef(false);
	const composingWikiLinkDraftRef = useRef(false);
	const wikiLinkPresentationFrameRef = useRef<number | null>(null);
	const wikiLinkPresentationMarkdownRef = useRef<string | null>(null);
	/**
	 * Selection seen by the previous `syncWikiLinkPresentation`. A draft can
	 * only become "abandoned" when the selection moves, so the region it left
	 * is the only place a newly stale draft can be.
	 */
	const previousSelectionRef = useRef<PlateEditor["selection"]>(null);
	const activeWikiLinkPathRef = useRef<{
		current: number[] | null;
		unref: () => number[] | null;
	} | null>(null);

	const expandWikiLinkAt = useCallback(
		(path: number[], cursorOffset: number) => {
			const entry = editor.api.node(path);
			if (!entry || !isWikiLinkNode(entry[0])) return false;
			const sourcePath = [...path, 0];
			let raw = wikiLinkNodeSource(entry[0]);
			if (!raw) {
				raw = wikiLinkToMarkdown(entry[0]);
				wikiLinkPresentationMarkdownRef.current = serialize();
				editor.tf.insertText(raw, {
					at: { path: sourcePath, offset: 0 },
				});
			}
			const point = {
				path: sourcePath,
				offset: Math.max(0, Math.min(cursorOffset, raw.length)),
			};
			editor.tf.select({ anchor: point, focus: point });
			return true;
		},
		[editor, serialize],
	);

	const isSelectionEditingWikiLinkDraft = useCallback(
		(path: number[], raw: string, selection = editor.selection) => {
			if (!selection) return false;
			if (RangeApi.isCollapsed(selection)) {
				return (
					selection.anchor.path.join(",") === path.join(",") &&
					isWikiLinkDraftEditingOffset(raw, selection.anchor.offset)
				);
			}
			const draftRange = editor.api.range(path);
			return draftRange
				? RangeApi.intersection(selection, draftRange) !== null
				: false;
		},
		[editor],
	);

	const selectedWikiLinkPath = useCallback(
		(selection: typeof editor.selection): number[] | null => {
			if (!selection) return null;
			for (const point of [selection.anchor, selection.focus]) {
				const parent = editor.api.parent(point.path);
				if (parent && isWikiLinkNode(parent[0])) return parent[1];
			}
			return null;
		},
		[editor],
	);

	/**
	 * Commit an edited source child back into the stable node's navigation
	 * attributes. Valid links keep the same element identity; invalid syntax is
	 * deliberately unwrapped to ordinary text so user input is never discarded.
	 */
	const syncWikiLinkNodeAt = useCallback(
		(path: number[]) => {
			const entry = editor.api.node(path);
			if (!entry || !isWikiLinkNode(entry[0])) return false;
			const raw = wikiLinkNodeSource(entry[0]);
			const parsed = parseWikiLinkMarkdown(raw);
			if (parsed && wikiLinkNodeMatchesSource(entry[0], parsed)) return true;

			wikiLinkPresentationMarkdownRef.current = serialize();
			if (parsed) {
				editor.tf.setNodes(
					{
						value: parsed.value,
						heading: parsed.heading,
						alias: parsed.alias ?? undefined,
						embed: parsed.embed === true ? true : undefined,
					},
					{ at: path },
				);
				return true;
			}

			const selectionRef = editor.selection
				? editor.api.rangeRef(editor.selection, { affinity: "forward" })
				: null;
			editor.tf.withoutNormalizing(() => {
				editor.tf.removeNodes({ at: path });
				editor.tf.insertNodes({ text: raw }, { at: path });
			});
			const selection = selectionRef?.unref();
			if (selection) editor.tf.select(selection);
			return false;
		},
		[editor, serialize],
	);

	/**
	 * Reify a complete editable source leaf into its display node. Presentation
	 * transitions keep the user's current selection; explicit keyboard exits
	 * request the text point immediately before or after the display node.
	 */
	const reifyWikiLinkDraftAt = useCallback(
		(
			path: number[],
			placement: "preserve" | "before" | "after" | "none" = "preserve",
		) => {
			const entry = editor.api.node(path);
			if (!entry || !isWikiLinkDraftText(entry[0])) return false;
			const parsed = parseWikiLinkMarkdown(entry[0].text);
			if (!parsed) return false;
			let resolvedPlacement = placement;
			if (
				placement === "preserve" &&
				editor.selection &&
				RangeApi.isCollapsed(editor.selection) &&
				editor.selection.anchor.path.join(",") === path.join(",")
			) {
				resolvedPlacement =
					wikiLinkDraftExteriorPlacement(
						entry[0].text,
						editor.selection.anchor.offset,
					) ?? placement;
			}
			wikiLinkPresentationMarkdownRef.current = serialize();
			const selectionRefs: { unref: () => typeof editor.selection }[] = [];
			const linkRefs: { unref: () => number[] | null }[] = [];
			editor.tf.withoutNormalizing(() => {
				if (resolvedPlacement === "preserve" && editor.selection) {
					selectionRefs.push(
						editor.api.rangeRef(editor.selection, { affinity: "forward" }),
					);
				}
				editor.tf.removeNodes({ at: path });
				editor.tf.insertNodes(parsed, { at: path });
				if (resolvedPlacement === "before" || resolvedPlacement === "after") {
					linkRefs.push(editor.api.pathRef(path, { affinity: "forward" }));
				}
			});

			if (resolvedPlacement === "preserve") {
				const selection = selectionRefs[0]?.unref();
				if (selection) editor.tf.select(selection);
				return true;
			}
			if (resolvedPlacement === "none") return true;
			const linkPath = linkRefs[0]?.unref();
			if (!linkPath) return true;
			const cursor =
				resolvedPlacement === "before"
					? editor.api.before(linkPath)
					: editor.api.after(linkPath);
			if (cursor) editor.tf.select(cursor);
			return true;
		},
		[editor, serialize],
	);

	/**
	 * The source/display distinction is a projection of the Slate selection.
	 * A complete draft cannot remain visible when that selection leaves it.
	 */
	const syncWikiLinkPresentation = useCallback(
		(selection: typeof editor.selection) => {
			if (
				syncingWikiLinkPresentationRef.current ||
				composingWikiLinkDraftRef.current
			) {
				return;
			}
			// Drafts only form under the caret (completion / template insert),
			// and the selection change that abandons one is exactly what runs
			// this sync — so only the region the selection just left or just
			// entered can hold a draft to reify. Scan those two regions instead
			// of the whole document on every caret move; the blur-time
			// `finalizeWikiLinkDrafts` keeps a full-document safety net.
			const draftRefs: ReturnType<typeof editor.api.pathRef>[] = [];
			const seenDraftKeys = new Set<string>();
			const regions = [previousSelectionRef.current, selection];
			previousSelectionRef.current = selection;
			for (const region of regions) {
				if (!region) continue;
				try {
					for (const [node, path] of editor.api.nodes({
						at: region,
						match: isWikiLinkDraftText,
					})) {
						if (!isWikiLinkDraftText(node)) continue;
						const key = path.join(",");
						if (seenDraftKeys.has(key)) continue;
						seenDraftKeys.add(key);
						if (parseWikiLinkMarkdown(node.text) === null) continue;
						if (isSelectionEditingWikiLinkDraft(path, node.text, selection))
							continue;
						draftRefs.push(editor.api.pathRef(path, { affinity: "forward" }));
					}
				} catch {
					// The region's nodes were deleted before this sync ran; a
					// deleted region cannot hold a draft left to reify.
				}
			}
			const selectedPath = selectedWikiLinkPath(selection);
			const activeRef = activeWikiLinkPathRef.current;
			const activePath = activeRef?.current;
			const selectionStayedInActive =
				activePath &&
				selectedPath &&
				activePath.join(",") === selectedPath.join(",");
			const stablePathToSync =
				activeRef && !selectionStayedInActive ? activeRef.unref() : null;
			if (activeRef && !selectionStayedInActive) {
				activeWikiLinkPathRef.current = null;
			}
			if (
				selectedPath &&
				(!activeWikiLinkPathRef.current ||
					activeWikiLinkPathRef.current.current?.join(",") !==
						selectedPath.join(","))
			) {
				activeWikiLinkPathRef.current = editor.api.pathRef(selectedPath, {
					affinity: "forward",
				});
			}
			if (!draftRefs.length && !stablePathToSync) return;
			syncingWikiLinkPresentationRef.current = true;
			try {
				for (const ref of draftRefs) {
					const path = ref.unref();
					if (path) reifyWikiLinkDraftAt(path);
				}
				if (stablePathToSync) syncWikiLinkNodeAt(stablePathToSync);
			} finally {
				for (const ref of draftRefs) ref.unref();
				syncingWikiLinkPresentationRef.current = false;
			}
		},
		[
			editor,
			isSelectionEditingWikiLinkDraft,
			reifyWikiLinkDraftAt,
			selectedWikiLinkPath,
			syncWikiLinkNodeAt,
		],
	);

	const scheduleWikiLinkPresentationSync = useCallback(() => {
		if (wikiLinkPresentationFrameRef.current !== null) return;
		wikiLinkPresentationFrameRef.current = window.requestAnimationFrame(() => {
			wikiLinkPresentationFrameRef.current = null;
			syncWikiLinkPresentation(editor.selection);
		});
	}, [editor, syncWikiLinkPresentation]);

	useEffect(
		() => () => {
			activeWikiLinkPathRef.current?.unref();
			activeWikiLinkPathRef.current = null;
			if (wikiLinkPresentationFrameRef.current === null) return;
			window.cancelAnimationFrame(wikiLinkPresentationFrameRef.current);
			wikiLinkPresentationFrameRef.current = null;
		},
		[],
	);

	const getWikiLinkExteriorBoundary =
		useCallback((): WikiLinkExteriorBoundary | null => {
			const selection = editor.selection;
			if (!selection || !RangeApi.isCollapsed(selection)) return null;
			const entry = editor.api.node(selection.anchor.path);
			if (!entry) return null;
			if (isWikiLinkDraftText(entry[0])) {
				const parsed = parseWikiLinkMarkdown(entry[0].text);
				if (!parsed) return null;
				const placement = wikiLinkDraftExteriorPlacement(
					entry[0].text,
					selection.anchor.offset,
				);
				return placement
					? {
							path: entry[1],
							placement,
							embed: parsed.embed === true,
							source: "draft",
						}
					: null;
			}
			if (typeof (entry[0] as { text?: unknown }).text !== "string") {
				return null;
			}
			const [leaf, leafPath] = entry as [{ text: string }, number[]];
			const parentEntry = editor.api.parent(leafPath);
			if (!parentEntry || leafPath.length !== parentEntry[1].length + 1) {
				return null;
			}
			if (isWikiLinkNode(parentEntry[0])) {
				const raw = wikiLinkNodeSource(parentEntry[0]);
				const placement = wikiLinkDraftExteriorPlacement(
					raw,
					selection.anchor.offset,
				);
				return placement
					? {
							path: parentEntry[1],
							placement,
							embed: parentEntry[0].embed === true,
							source: "stable",
						}
					: null;
			}
			const [parent, parentPath] = parentEntry as [
				{ children?: unknown[] },
				number[],
			];
			const index = leafPath[leafPath.length - 1];
			const placement =
				selection.anchor.offset === 0
					? ("after" as const)
					: selection.anchor.offset === leaf.text.length
						? ("before" as const)
						: null;
			const adjacentIndex =
				placement === "after"
					? index - 1
					: placement === "before"
						? index + 1
						: -1;
			const adjacent = parent.children?.[adjacentIndex];
			if (!placement || adjacentIndex < 0 || !isWikiLinkNode(adjacent)) {
				return null;
			}
			return {
				path: [...parentPath, adjacentIndex],
				placement,
				embed: adjacent.embed === true,
				source: "display",
			};
		}, [editor]);

	const prepareWikiLinkBoundaryInput = useCallback(
		(boundary: WikiLinkExteriorBoundary) => {
			if (
				boundary.source === "draft" &&
				!reifyWikiLinkDraftAt(boundary.path, boundary.placement)
			) {
				return false;
			}
			if (boundary.source === "stable") {
				const point =
					boundary.placement === "before"
						? editor.api.before(boundary.path)
						: editor.api.after(boundary.path);
				if (!point) return false;
				editor.tf.select(point);
			}
			if (boundary.embed && boundary.placement === "after") {
				editor.tf.insertBreak();
			}
			return true;
		},
		[editor, reifyWikiLinkDraftAt],
	);

	const handleWikiLinkBoundaryBeforeInput = useCallback(
		(event: FormEvent<HTMLDivElement>) => {
			const nativeEvent = event.nativeEvent as InputEvent;
			const inputType = nativeEvent.inputType ?? "";
			// Slash menu confirms with Enter: keydown is preventDefault'd, but
			// WebKit/Tauri still emits beforeinput insertParagraph afterwards,
			// which would put the caret on a new line after the command runs.
			if (
				suppressNextEditorBreakRef.current &&
				(inputType === "insertParagraph" || inputType === "insertLineBreak")
			) {
				event.preventDefault();
				suppressNextEditorBreakRef.current = false;
				return;
			}
			if (nativeEvent.isComposing || !inputType.startsWith("insert")) {
				return;
			}
			if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
				return;
			}
			const text =
				nativeEvent.data ??
				nativeEvent.dataTransfer?.getData("text/plain") ??
				"";
			if (!text) return;
			const boundary = getWikiLinkExteriorBoundary();
			if (
				text === "!" &&
				boundary?.placement === "before" &&
				!boundary.embed &&
				boundary.source !== "draft"
			) {
				const entry = editor.api.node(boundary.path);
				if (!entry || !isWikiLinkNode(entry[0])) return;
				const link = entry[0];
				const raw = wikiLinkNodeSource(link);
				const sourcePath = [...boundary.path, 0];
				editor.tf.withoutNormalizing(() => {
					editor.tf.insertText(raw ? "!" : `!${wikiLinkToMarkdown(link)}`, {
						at: { path: sourcePath, offset: 0 },
					});
					editor.tf.setNodes({ embed: true }, { at: boundary.path });
					const point = { path: sourcePath, offset: 1 };
					editor.tf.select({ anchor: point, focus: point });
				});
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (!boundary || !prepareWikiLinkBoundaryInput(boundary)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			editor.tf.insertText(text);
		},
		[
			editor,
			getWikiLinkExteriorBoundary,
			prepareWikiLinkBoundaryInput,
			suppressNextEditorBreakRef,
		],
	);

	const handleWikiLinkArrow = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			const direction = wikiLinkArrowDirection(event);
			if (!direction) return false;
			const selection = editor.selection;
			if (!selection || !RangeApi.isCollapsed(selection)) {
				return false;
			}
			const entry = editor.api.node(selection.anchor.path);
			if (!entry || typeof (entry[0] as { text?: unknown }).text !== "string") {
				return false;
			}
			const [leaf, leafPath] = entry as [{ text: string }, number[]];
			if (isWikiLinkDraftText(leaf)) return false;
			const parentEntry = editor.api.parent(leafPath);
			if (!parentEntry || leafPath.length !== parentEntry[1].length + 1) {
				return false;
			}
			const [parent, parentPath] = parentEntry as [
				{ children?: unknown[] },
				number[],
			];
			const index = leafPath[leafPath.length - 1];
			const adjacentIndex =
				direction === "backward" && selection.anchor.offset === 0
					? index - 1
					: direction === "forward" &&
							selection.anchor.offset === leaf.text.length
						? index + 1
						: -1;
			const adjacent = parent.children?.[adjacentIndex];
			if (adjacentIndex < 0 || !isWikiLinkNode(adjacent)) return false;
			const isVertical = event.key === "ArrowUp" || event.key === "ArrowDown";
			if (isVertical && !adjacent.embed) return false;
			const raw = wikiLinkNodeSource(adjacent) || wikiLinkToMarkdown(adjacent);
			const { start, end } = wikiLinkDraftEditableBounds(raw);
			const expanded = expandWikiLinkAt(
				[...parentPath, adjacentIndex],
				direction === "backward" ? end : start,
			);
			if (expanded) event.preventDefault();
			return expanded;
		},
		[editor, expandWikiLinkAt],
	);

	const handleWikiLinkBoundaryDelete = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (
				event.key !== "Backspace" ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey
			) {
				return false;
			}
			const boundary = getWikiLinkExteriorBoundary();
			if (
				boundary?.source !== "display" ||
				boundary.placement !== "after" ||
				!boundary.embed
			) {
				return false;
			}
			const entry = editor.api.node(boundary.path);
			if (!entry || !isWikiLinkNode(entry[0])) return false;
			const raw = wikiLinkToMarkdown(entry[0]);
			if (!expandWikiLinkAt(boundary.path, raw.length)) return false;
			const caret = editor.selection?.anchor;
			if (!caret || caret.offset < 1) return false;
			editor.tf.delete({
				at: {
					anchor: { path: caret.path, offset: caret.offset - 1 },
					focus: caret,
				},
			});
			event.preventDefault();
			return true;
		},
		[editor, expandWikiLinkAt, getWikiLinkExteriorBoundary],
	);

	const handleWikiLinkDraftEnter = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (event.key !== "Enter") return false;
			const selection = editor.selection;
			if (!selection || !RangeApi.isCollapsed(selection)) {
				return false;
			}
			const entry = editor.api.node(selection.anchor.path);
			if (!entry) return false;
			if (!isWikiLinkDraftText(entry[0])) {
				const parentEntry = editor.api.parent(entry[1]);
				if (!parentEntry || !isWikiLinkNode(parentEntry[0])) return false;
				const raw = wikiLinkNodeSource(parentEntry[0]);
				const { end } = wikiLinkDraftEditableBounds(raw);
				if (selection.anchor.offset !== end || !parseWikiLinkMarkdown(raw)) {
					return false;
				}
				syncWikiLinkNodeAt(parentEntry[1]);
				const after = editor.api.after(parentEntry[1]);
				if (!after) return false;
				editor.tf.select(after);
				event.preventDefault();
				editor.tf.insertBreak();
				return true;
			}
			const { end } = wikiLinkDraftEditableBounds(entry[0].text);
			const boundary = getWikiLinkExteriorBoundary();
			const placement =
				selection.anchor.offset === end ? "after" : boundary?.placement;
			const path = boundary?.source === "draft" ? boundary.path : entry[1];
			if (!placement) return false;
			const collapsed = reifyWikiLinkDraftAt(path, placement);
			if (!collapsed) return false;
			event.preventDefault();
			editor.tf.insertBreak();
			return true;
		},
		[
			editor,
			getWikiLinkExteriorBoundary,
			reifyWikiLinkDraftAt,
			syncWikiLinkNodeAt,
		],
	);

	/**
	 * A cursor crossing a display-node boundary creates a marked, ordinary text
	 * leaf. On blur, reify only complete valid syntax; unfinished text deliberately stays
	 * as text so IME composition, deletion, and pasted drafts retain normal
	 * editor semantics.
	 */
	const finalizeWikiLinkDrafts = useCallback(() => {
		const draftRefs: ReturnType<typeof editor.api.pathRef>[] = [];
		for (const [, path] of editor.api.nodes({
			at: [],
			match: isWikiLinkDraftText,
		})) {
			draftRefs.push(editor.api.pathRef(path, { affinity: "forward" }));
		}
		if (!draftRefs.length) return;
		syncingWikiLinkPresentationRef.current = true;
		try {
			editor.tf.withoutNormalizing(() => {
				for (const ref of draftRefs) {
					const path = ref.unref();
					if (!path) continue;
					const entry = editor.api.node(path);
					const node = entry?.[0];
					if (!isWikiLinkDraftText(node)) continue;
					if (!parseWikiLinkMarkdown(node.text)) {
						editor.tf.unsetNodes("wikiLinkDraft", { at: path });
						continue;
					}
					reifyWikiLinkDraftAt(path, "none");
				}
			});
		} finally {
			for (const ref of draftRefs) ref.unref();
			syncingWikiLinkPresentationRef.current = false;
		}
		syncWikiLinkPresentation(null);
	}, [editor, reifyWikiLinkDraftAt, syncWikiLinkPresentation]);

	const handleWikiLinkCompositionStart = useCallback(() => {
		composingWikiLinkDraftRef.current = true;
		const boundary = getWikiLinkExteriorBoundary();
		if (boundary) {
			prepareWikiLinkBoundaryInput(boundary);
		}
	}, [getWikiLinkExteriorBoundary, prepareWikiLinkBoundaryInput]);

	const handleWikiLinkCompositionEnd = useCallback(() => {
		composingWikiLinkDraftRef.current = false;
		scheduleWikiLinkPresentationSync();
	}, [scheduleWikiLinkPresentationSync]);

	const consumePresentationMarkdown = useCallback(() => {
		const snapshot = wikiLinkPresentationMarkdownRef.current;
		wikiLinkPresentationMarkdownRef.current = null;
		return snapshot;
	}, []);

	return {
		syncWikiLinkPresentation,
		scheduleWikiLinkPresentationSync,
		consumePresentationMarkdown,
		handleWikiLinkBoundaryBeforeInput,
		handleWikiLinkArrow,
		handleWikiLinkBoundaryDelete,
		handleWikiLinkDraftEnter,
		handleWikiLinkCompositionStart,
		handleWikiLinkCompositionEnd,
		finalizeWikiLinkDrafts,
	};
}
