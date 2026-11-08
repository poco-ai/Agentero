import type { EditorView } from "@codemirror/view";
import { useTheme } from "next-themes";
import type { TElement } from "platejs";
import type { PlateEditor } from "platejs/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { MarkdownPersistence } from "@/components/editor/hooks/use-markdown-persistence";
import {
	configureMarkdownSourceView,
	createMarkdownSourceView,
	loadMarkdownSourceView,
} from "@/components/editor/markdown-source-view";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { notifyError } from "@/lib/core/notify";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import {
	bodyStartLineOfBlock,
	frontmatterLineOffset,
} from "@/lib/markdown/selection-source-lines";
import {
	blockAtSourceLine,
	sourceBlockLines,
} from "@/lib/markdown/source-block-lines";
import {
	type CaretPoint,
	renderedPointAtSource,
	sourceCaretInBlock,
} from "@/lib/markdown/source-caret";
import {
	scrollTopForViewportAnchor,
	visibleAnchorTop,
} from "@/lib/markdown/source-mode-alignment";

type SourceMode = "rendered" | "entering" | "source" | "leaving";

function blockAtViewport(
	editor: PlateEditor,
	root: HTMLElement,
): number | null {
	const rect = root.getBoundingClientRect();
	const slateRoot = editor.api.toDOMNode(editor);
	if (!slateRoot) return null;
	// The pane's top edge often lands on padding or the gap between blocks, so
	// probe a little further before giving up on the visible block.
	for (const offset of [4, 24, 64]) {
		const hit = document.elementFromPoint(
			rect.left + rect.width / 2,
			rect.top + offset,
		);
		if (!hit || !root.contains(hit)) continue;
		let block: Element | null = hit;
		while (block && block.parentElement !== slateRoot)
			block = block.parentElement;
		if (!block) continue;
		const node = editor.api.toSlateNode(block);
		const index = node ? (editor.api.findPath(node)?.[0] ?? null) : null;
		if (index !== null) return index;
	}
	return null;
}

/** Caret top in px from the editor viewport, or null when it isn't rendered. */
function caretTopIn(
	editor: PlateEditor,
	container: HTMLElement,
): number | null {
	const focus = editor.selection?.focus;
	if (!focus) return null;
	try {
		// Collapse at the focus point so a non-empty selection still reports
		// where the user is about to type, not where the selection starts.
		const range = editor.api.toDOMRange({ anchor: focus, focus });
		if (!range || !container.contains(range.startContainer)) return null;
		return (
			range.getBoundingClientRect().top - container.getBoundingClientRect().top
		);
	} catch {
		return null;
	}
}

/** Rendered block top in px from the editor viewport. */
function blockTopIn(
	editor: PlateEditor,
	container: HTMLElement,
	index: number,
): number | null {
	const node = editor.children[index];
	const dom = node ? editor.api.toDOMNode(node) : null;
	return dom
		? dom.getBoundingClientRect().top - container.getBoundingClientRect().top
		: null;
}

/** Source caret top in px from the CodeMirror viewport, or null when not laid out. */
function sourceCaretViewportTop(view: EditorView): number | null {
	const head = view.state.selection.main.head;
	const coords = view.coordsAtPos(head);
	return coords
		? coords.top - view.scrollDOM.getBoundingClientRect().top
		: null;
}

/**
 * Source line to map back to a rendered block. The caret's line wins while it
 * is on screen; once scrolled away, the line at the viewport top does, so the
 * anchor never lands outside the scroll range.
 */
function sourceAnchorLine(view: EditorView): number {
	const scroller = view.scrollDOM;
	const caretTop = visibleAnchorTop(
		sourceCaretViewportTop(view),
		scroller.clientHeight,
	);
	if (caretTop !== null)
		return view.state.doc.lineAt(view.state.selection.main.head).number;
	const block = view.lineBlockAtHeight(
		scroller.getBoundingClientRect().top - view.documentTop,
	);
	return view.state.doc.lineAt(block.from).number;
}

/** Rendered caret top in px from the editor viewport. */
function renderedCaretTopIn(
	editor: PlateEditor,
	container: HTMLElement,
	point: CaretPoint,
): number | null {
	try {
		const range = editor.api.toDOMRange({ anchor: point, focus: point });
		if (!range) return null;
		const rect = range.getBoundingClientRect();
		// WebKit reports an all-zero rect for a point that has not been laid out.
		if (
			!rect ||
			(rect.top === 0 &&
				rect.left === 0 &&
				rect.width === 0 &&
				rect.height === 0)
		)
			return null;
		return rect.top - container.getBoundingClientRect().top;
	} catch {
		return null;
	}
}

/**
 * Scroll the source view so its caret line sits at `anchorViewportTop`.
 * `setState` rebuilds CodeMirror's height map from estimated line heights, so
 * re-apply after the measured pass instead of trusting the first estimate.
 */
function alignSourceViewport(view: EditorView, anchorViewportTop: number) {
	const head = view.state.selection.main.head;
	let expected = view.scrollDOM.scrollTop;
	let attempts = 0;
	const apply = () => {
		if (!view.dom.isConnected) return;
		const scroller = view.scrollDOM;
		// The user took over the scroll while the switch was settling.
		if (Math.abs(scroller.scrollTop - expected) > 1) return;
		const next = scrollTopForViewportAnchor({
			// Prefer the caret's painted line box; a line block starts above
			// the text, which would leave a small gap on every switch.
			anchorTop: (() => {
				const caret = view.coordsAtPos(head);
				if (caret) {
					return (
						scroller.scrollTop +
						caret.top -
						scroller.getBoundingClientRect().top
					);
				}
				// CodeMirror line coordinates start at the first line, below the
				// content padding that `scrollTop` includes.
				return view.documentPadding.top + view.lineBlockAt(head).top;
			})(),
			anchorViewportTop,
			scrollHeight: scroller.scrollHeight,
			clientHeight: scroller.clientHeight,
		});
		attempts += 1;
		const settled = Math.abs(scroller.scrollTop - next) < 0.5;
		if (!settled) scroller.scrollTop = next;
		expected = scroller.scrollTop;
		if (attempts >= 4 || (settled && attempts > 1)) return;
		requestAnimationFrame(apply);
	};
	apply();
}

/**
 * Put the rendered caret back at `anchorViewportTop`, then re-check once so a
 * late layout pass (selection sync, re-created nodes) cannot leave it off.
 */
function alignRenderedCaret(
	editor: PlateEditor,
	container: HTMLElement,
	point: CaretPoint,
	anchorViewportTop: number,
	fallback: Element | null,
) {
	let expected = container.scrollTop;
	let attempts = 0;
	const apply = () => {
		if (!container.isConnected) return;
		// The user took over the scroll while the switch was settling.
		if (Math.abs(container.scrollTop - expected) > 1) return;
		const caret = renderedCaretTopIn(editor, container, point);
		const top =
			caret ??
			(fallback
				? fallback.getBoundingClientRect().top -
					container.getBoundingClientRect().top
				: null);
		if (top === null) return;
		container.scrollTop = scrollTopForViewportAnchor({
			anchorTop: top + container.scrollTop,
			anchorViewportTop,
			scrollHeight: container.scrollHeight,
			clientHeight: container.clientHeight,
		});
		expected = container.scrollTop;
		attempts += 1;
		if (attempts < 2) requestAnimationFrame(apply);
	};
	apply();
}

export function useMarkdownSource({
	editor,
	editorContainerRef,
	persistence,
	onEnter,
	active,
}: {
	editor: PlateEditor;
	editorContainerRef: RefObject<HTMLDivElement | null>;
	persistence: MarkdownPersistence;
	onEnter: () => void;
	active: boolean;
}) {
	const { t } = useTranslation("editor");
	const { resolvedTheme } = useTheme();
	const dark = resolvedTheme === "dark";
	const [mode, setMode] = useState<SourceMode>("rendered");
	const modeRef = useRef<SourceMode>("rendered");
	const committedMode = useRef<SourceMode>("rendered");
	const sourceHostRef = useRef<HTMLDivElement>(null);
	const sourceViewRef = useRef<EditorView | null>(null);
	const frame = useRef(0);
	const switchMeasure = useRef<{ name: string; start: number } | null>(null);
	const deferredSwitch = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activeRef = useRef(active);
	activeRef.current = active;
	const restore = useRef<(() => void) | null>(null);
	const baseline = useRef<{ raw: string; lines: number[] } | null>(null);

	const { beginSource, endSource, saveNow, serialize, updateSource } =
		persistence;
	const changeMode = useCallback((next: SourceMode) => {
		modeRef.current = next;
		setMode(next);
	}, []);

	const prefs = useMemo(
		() => ({
			dark,
			zwspLabel: t("source.zwspPlaceholder"),
			phrases: {
				"Markdown source": t("source.showSource"),
				Find: t("findReplace.searchPlaceholder"),
				Replace: t("findReplace.replacePlaceholder"),
				next: t("findReplace.next"),
				previous: t("findReplace.prev"),
				all: t("source.allMatches"),
				"match case": t("source.matchCase"),
				regexp: t("source.regexp"),
				"by word": t("source.wholeWord"),
				replace: t("findReplace.replace"),
				"replace all": t("findReplace.replaceAll"),
				close: t("findReplace.close"),
				"current match": t("source.currentMatch"),
				"on line": t("source.onLine"),
				"replaced match on line $": t("source.replacedLine"),
				"replaced $ matches": t("source.replacedMatches"),
			},
		}),
		[dark, t],
	);
	useLayoutEffect(() => {
		if (sourceViewRef.current)
			configureMarkdownSourceView(sourceViewRef.current, prefs);
	}, [prefs]);

	const loadSource = useCallback(
		(raw: string, line: number, offset = 0, reuse = false) => {
			const host = sourceHostRef.current;
			if (!host) return null;
			sourceViewRef.current ??= createMarkdownSourceView(host);
			const view = sourceViewRef.current;
			loadMarkdownSourceView(view, raw, {
				line,
				offset,
				save: () => {
					void saveNow();
				},
				update: updateSource,
				prefs,
				reuse,
			});
			return view;
		},
		[prefs, saveNow, updateSource],
	);

	const replaceSource = useCallback(
		(raw: string) => {
			if (modeRef.current !== "source" && modeRef.current !== "leaving")
				return false;
			const view = sourceViewRef.current;
			if (!view) return false;
			const pos = view.state.selection.main.head;
			const line = view.state.doc.lineAt(pos);
			const top = view.scrollDOM.scrollTop;
			const hadFocus = view.dom.contains(document.activeElement);
			loadSource(raw, line.number, pos - line.from);
			baseline.current = { raw, lines: sourceBlockLines(raw) };
			view.scrollDOM.scrollTop = top;
			if (hadFocus) view.focus();
			return true;
		},
		[loadSource],
	);

	const toggle = useCallback(() => {
		const current = modeRef.current;
		if (current !== "source" && current !== "rendered") return;
		const entering = current === "rendered";
		const started = performance.now();
		changeMode(entering ? "entering" : "leaving");
		const performSwitch = () => {
			if (deferredSwitch.current === null) return;
			clearTimeout(deferredSwitch.current);
			deferredSwitch.current = null;
			cancelAnimationFrame(frame.current);
			const conversionStart = performance.now();
			try {
				if (entering) {
					const container = editorContainerRef.current;
					const viewport = container
						? blockAtViewport(editor, container)
						: null;
					const caretBlock = editor.selection?.focus.path[0] ?? null;
					const caretTop = container ? caretTopIn(editor, container) : null;
					const caretVisibleTop = container
						? visibleAnchorTop(caretTop, container.clientHeight)
						: null;
					const caretVisible = caretVisibleTop !== null && caretBlock !== null;
					// Keep the caret where it is. An off-screen caret cannot be
					// anchored without clamping to the document edge, so use the
					// block at the top of the viewport instead.
					const block = caretVisible
						? caretBlock
						: (viewport ?? caretBlock ?? 0);
					onEnter();
					const raw = persistence.dirtyRef.current
						? serialize()
						: persistence.savedRef.current;
					const lines =
						baseline.current?.raw === raw
							? baseline.current.lines
							: sourceBlockLines(raw);
					const { frontmatter } = splitFrontmatter(raw);
					const sourceLineCount = raw
						.replace(/\r\n?/g, "\n")
						.split("\n").length;
					const lineOf = (index: number): number | null => {
						if (index < 0 || index >= editor.children.length) return null;
						if (lines.length === editor.children.length)
							return lines[index] ?? null;
						const bodyLine = bodyStartLineOfBlock(editor, index);
						return bodyLine === null
							? null
							: bodyLine + frontmatterLineOffset(frontmatter);
					};
					const startLine = lineOf(block) ?? 1;
					const endLine = lineOf(block + 1) ?? sourceLineCount + 1;
					const blockNode = editor.children[block] as TElement | undefined;
					const precise =
						caretVisible && blockNode
							? sourceCaretInBlock(
									editor,
									blockNode,
									block,
									raw,
									startLine,
									endLine,
								)
							: null;
					const caretLine = precise?.line ?? startLine;
					const caretColumn = precise?.column ?? 0;
					// A precise caret keeps its own screen height. Without one the
					// source view falls back to the block's first line, so anchor
					// that line instead of leaving it off-screen.
					const blockTop = container
						? blockTopIn(editor, container, block)
						: null;
					const anchorTop = precise
						? (caretVisibleTop ?? 0)
						: Math.max(
								0,
								Math.min(blockTop ?? 0, container?.clientHeight ?? 0),
							);
					// The text is usually unchanged across a toggle. Reusing the
					// CodeMirror state keeps its measured height map, which is what
					// makes repeated switches land at the same height.
					const view = loadSource(
						raw,
						caretLine,
						caretColumn,
						baseline.current?.raw === raw,
					);
					if (!view) throw new Error("Missing Markdown source surface");
					baseline.current = { raw, lines };
					beginSource(raw);
					restore.current = () => {
						if (activeRef.current) view.focus();
						alignSourceViewport(view, anchorTop);
					};
					changeMode("source");
				} else {
					const raw = serialize();
					const { body, frontmatter } = splitFrontmatter(raw);
					const original = baseline.current;
					const unchanged = original?.raw === raw;
					const value = unchanged
						? null
						: deserializeMarkdownBody(editor, body, {
								throwOnError: true,
							});
					const blocks = value ?? editor.children;
					const lines = unchanged ? original.lines : sourceBlockLines(raw);
					const view = sourceViewRef.current;
					const scroller = view?.scrollDOM ?? null;
					// A switch can beat React's commit, leaving the source
					// surface hidden for this pass. Its viewport is meaningless
					// then, so fall back to the caret itself instead of reading
					// line 1 from a zero-height scroller.
					const laidOut =
						view !== null &&
						scroller !== null &&
						scroller.clientHeight > 0 &&
						view.dom.getClientRects().length > 0;
					const caretTop =
						view && laidOut ? sourceCaretViewportTop(view) : null;
					const caretVisibleTop =
						scroller && laidOut
							? visibleAnchorTop(caretTop, scroller.clientHeight)
							: null;
					const caretVisible = caretVisibleTop !== null;
					const head = view?.state.selection.main.head ?? 0;
					const headLine = view ? view.state.doc.lineAt(head) : null;
					const useCaret = caretVisible || !laidOut;
					const sourceLine = view
						? headLine && useCaret
							? headLine.number
							: sourceAnchorLine(view)
						: 1;
					const sourceColumn = headLine && useCaret ? head - headLine.from : 0;
					const selected = Math.min(
						blockAtSourceLine(lines, sourceLine),
						Math.max(0, blocks.length - 1),
					);
					const sourceLineCount = raw
						.replace(/\r\n?/g, "\n")
						.split("\n").length;
					const lineOf = (index: number): number | null => {
						if (index < 0 || index >= blocks.length) return null;
						if (lines.length === blocks.length) return lines[index] ?? null;
						// The parsed value owns its own block order; the editor still
						// holds the pre-edit tree until `endSource`.
						if (!unchanged) return lines[index] ?? null;
						const bodyLine = bodyStartLineOfBlock(editor, index);
						return bodyLine === null
							? null
							: bodyLine + frontmatterLineOffset(frontmatter);
					};
					const startLine = lineOf(selected) ?? sourceLine;
					const endLine = lineOf(selected + 1) ?? sourceLineCount + 1;
					const blockNode = blocks[selected] as TElement | undefined;
					const precise =
						blockNode && headLine
							? renderedPointAtSource(
									blockNode,
									selected,
									raw,
									startLine,
									endLine,
									sourceLine,
									sourceColumn,
								)
							: null;
					const anchorTop = caretVisible ? (caretVisibleTop ?? 0) : 0;
					endSource(value, frontmatter);
					baseline.current = { raw, lines };
					restore.current = () => {
						const point = precise ?? editor.api.start([selected]);
						if (activeRef.current)
							editor.api.toDOMNode(editor)?.focus({ preventScroll: true });
						if (point) {
							editor.tf.select(point);
							if (activeRef.current) {
								// `tf.select` is a no-op when Slate already holds this
								// point, while the raw focus above resets the DOM caret
								// to the document start. Write the range back so the
								// pending selection sync cannot move Slate to block 0.
								const range = editor.api.toDOMRange({
									anchor: point,
									focus: point,
								});
								const selection = window.getSelection();
								if (range && selection) {
									selection.removeAllRanges();
									selection.addRange(range);
								}
							}
						}
						const container = editorContainerRef.current;
						const node = editor.children[selected];
						const dom = node ? editor.api.toDOMNode(node) : null;
						if (container && point)
							alignRenderedCaret(
								editor,
								container,
								point,
								anchorTop,
								dom ?? null,
							);
					};
					changeMode("rendered");
				}
				performance.measure(
					entering ? "markdown-source:enter-work" : "markdown-source:exit-work",
					{
						start: conversionStart,
						end: performance.now(),
					},
				);
				switchMeasure.current = {
					name: entering ? "markdown-source:enter" : "markdown-source:exit",
					start: started,
				};
			} catch (error) {
				logger.warn("Markdown source switch failed", {
					direction: entering ? "enter" : "exit",
					error: errorText(error),
				});
				changeMode(entering ? "rendered" : "source");
				notifyError(t(entering ? "source.openFailed" : "source.renderFailed"));
			}
		};
		// Give the placeholder a frame to paint, but finish even when WebKit
		// suspends frames because the window becomes hidden mid-switch.
		deferredSwitch.current = setTimeout(
			performSwitch,
			document.hidden ? 0 : 100,
		);
		frame.current = requestAnimationFrame(() => {
			frame.current = requestAnimationFrame(() => {
				// Exiting reads the source surface's viewport. Wait until React
				// has committed `leaving`; the timeout below covers a slow frame.
				if (entering || committedMode.current === "leaving") performSwitch();
			});
		});
	}, [
		beginSource,
		changeMode,
		editor,
		editorContainerRef,
		endSource,
		loadSource,
		onEnter,
		persistence.dirtyRef,
		persistence.savedRef,
		serialize,
		t,
	]);

	useLayoutEffect(() => {
		committedMode.current = mode;
		if (mode !== "source" && mode !== "rendered") return;
		const apply = restore.current;
		restore.current = null;
		apply?.();
		const measure = switchMeasure.current;
		switchMeasure.current = null;
		if (measure)
			performance.measure(measure.name, {
				start: measure.start,
				end: performance.now(),
			});
	}, [mode]);

	useEffect(
		() => () => {
			cancelAnimationFrame(frame.current);
			if (deferredSwitch.current !== null) clearTimeout(deferredSwitch.current);
			deferredSwitch.current = null;
			sourceViewRef.current?.destroy();
			sourceViewRef.current = null;
		},
		[],
	);

	return {
		source: mode === "source" || mode === "leaving",
		switching: mode === "entering" || mode === "leaving",
		sourceHostRef,
		sourceViewRef,
		toggle,
		replaceSource,
	};
}
