import type { EditorView } from "@codemirror/view";
import { useTheme } from "next-themes";
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
import { scrollTopForViewportAnchor } from "@/lib/markdown/source-mode-alignment";

type SourceMode = "rendered" | "entering" | "source" | "leaving";

function blockAtViewport(
	editor: PlateEditor,
	root: HTMLElement,
): number | null {
	const rect = root.getBoundingClientRect();
	const hit = document.elementFromPoint(
		rect.left + rect.width / 2,
		rect.top + 4,
	);
	if (!hit || !root.contains(hit)) return null;
	const slateRoot = editor.api.toDOMNode(editor);
	let block: Element | null = hit;
	while (block && block.parentElement !== slateRoot)
		block = block.parentElement;
	if (!block || !slateRoot) return null;
	const node = editor.api.toSlateNode(block);
	return node ? (editor.api.findPath(node)?.[0] ?? null) : null;
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

/** Source caret top in px from the CodeMirror viewport. */
function sourceCaretViewportTop(view: EditorView): number {
	const head = view.state.selection.main.head;
	const coords = view.coordsAtPos(head);
	return coords
		? coords.top - view.scrollDOM.getBoundingClientRect().top
		: view.lineBlockAt(head).top - view.scrollDOM.scrollTop;
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
		(raw: string, line: number, offset = 0) => {
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
					const block = editor.selection?.focus.path[0] ?? viewport ?? 0;
					// Keep the caret at its current height instead of pinning the
					// whole block to the viewport top. Fall back to the block top
					// when the caret rect isn't available (e.g. a hidden pane).
					const caretTop = container
						? (caretTopIn(editor, container) ??
							blockTopIn(editor, container, block) ??
							0)
						: 0;
					onEnter();
					const raw = persistence.dirtyRef.current
						? serialize()
						: persistence.savedRef.current;
					const lines =
						baseline.current?.raw === raw
							? baseline.current.lines
							: sourceBlockLines(raw);
					const { frontmatter } = splitFrontmatter(raw);
					const lineOf = (index: number) => {
						if (lines.length === editor.children.length)
							return lines[index] ?? 1;
						return (
							(bodyStartLineOfBlock(editor, index) ?? 1) +
							frontmatterLineOffset(frontmatter)
						);
					};
					const caretLine = lineOf(block);
					const view = loadSource(raw, caretLine);
					if (!view) throw new Error("Missing Markdown source surface");
					baseline.current = { raw, lines };
					beginSource(raw);
					restore.current = () => {
						if (activeRef.current) view.focus();
						// The view was created while its host was hidden; force a
						// fresh measurement before mapping the caret height.
						view.requestMeasure();
						const head = view.state.selection.main.head;
						view.scrollDOM.scrollTop = scrollTopForViewportAnchor({
							anchorTop: view.lineBlockAt(head).top,
							anchorViewportTop: caretTop,
							scrollHeight: view.scrollDOM.scrollHeight,
							clientHeight: view.scrollDOM.clientHeight,
						});
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
					const lines = unchanged ? original.lines : sourceBlockLines(raw);
					const view = sourceViewRef.current;
					const selectionLine =
						view?.state.doc.lineAt(view.state.selection.main.head).number ?? 1;
					const caretTop = view ? sourceCaretViewportTop(view) : 0;
					const blockFor = (line: number) =>
						Math.min(
							blockAtSourceLine(lines, line),
							Math.max(0, (value?.length ?? editor.children.length) - 1),
						);
					const selected = blockFor(selectionLine);
					endSource(value, frontmatter);
					baseline.current = { raw, lines };
					restore.current = () => {
						const point = editor.api.start([selected]);
						if (point) editor.tf.select(point);
						if (activeRef.current)
							editor.api.toDOMNode(editor)?.focus({ preventScroll: true });
						const container = editorContainerRef.current;
						const node = editor.children[selected];
						const dom = node && editor.api.toDOMNode(node);
						if (container && dom) {
							// Convert the rendered block's document offset back to
							// viewport space, then place it at the height the source
							// caret occupied.
							const anchorTop =
								dom.getBoundingClientRect().top -
								container.getBoundingClientRect().top +
								container.scrollTop;
							container.scrollTop = scrollTopForViewportAnchor({
								anchorTop,
								anchorViewportTop: caretTop,
								scrollHeight: container.scrollHeight,
								clientHeight: container.clientHeight,
							});
						}
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
			frame.current = requestAnimationFrame(performSwitch);
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
		toggle,
		replaceSource,
	};
}
