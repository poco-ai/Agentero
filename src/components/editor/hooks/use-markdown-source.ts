import { EditorView } from "@codemirror/view";
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
	const deferredSwitch = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activeRef = useRef(active);
	activeRef.current = active;
	const restore = useRef<(() => void) | null>(null);

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
					onEnter();
					const raw = persistence.dirtyRef.current
						? serialize()
						: persistence.savedRef.current;
					const lines = sourceBlockLines(raw);
					const { frontmatter } = splitFrontmatter(raw);
					const lineOf = (index: number) => {
						if (lines.length === editor.children.length)
							return lines[index] ?? 1;
						return (
							(bodyStartLineOfBlock(editor, index) ?? 1) +
							frontmatterLineOffset(frontmatter)
						);
					};
					const view = loadSource(raw, lineOf(block));
					if (!view) throw new Error("Missing Markdown source surface");
					beginSource(raw);
					restore.current = () => {
						if (!view) return;
						const pos = view.state.doc.line(
							Math.min(lineOf(viewport ?? block), view.state.doc.lines),
						).from;
						if (activeRef.current) view.focus();
						view.dispatch({
							effects: EditorView.scrollIntoView(pos, { y: "start" }),
						});
					};
					changeMode("source");
				} else {
					const raw = serialize();
					const { body, frontmatter } = splitFrontmatter(raw);
					const value = deserializeMarkdownBody(editor, body, {
						throwOnError: true,
					});
					const lines = sourceBlockLines(raw);
					const view = sourceViewRef.current;
					const selectionLine =
						view?.state.doc.lineAt(view.state.selection.main.head).number ?? 1;
					const viewportLine =
						view?.state.doc.lineAt(
							view.lineBlockAtHeight(
								view.scrollDOM.getBoundingClientRect().top - view.documentTop,
							).from,
						).number ?? selectionLine;
					const blockFor = (line: number) =>
						Math.min(
							blockAtSourceLine(lines, line),
							Math.max(0, value.length - 1),
						);
					const selected = blockFor(selectionLine);
					const visible = blockFor(viewportLine);
					endSource(value, frontmatter);
					restore.current = () => {
						const point = editor.api.start([selected]);
						if (point) editor.tf.select(point);
						if (activeRef.current)
							editor.api.toDOMNode(editor)?.focus({ preventScroll: true });
						const container = editorContainerRef.current;
						const node = editor.children[visible];
						const dom = node && editor.api.toDOMNode(node);
						if (container && dom) {
							container.scrollTop +=
								dom.getBoundingClientRect().top -
								container.getBoundingClientRect().top;
						}
					};
					changeMode("rendered");
					if (persistence.dirtyRef.current) void saveNow();
				}
				performance.measure(
					entering ? "markdown-source:enter-work" : "markdown-source:exit-work",
					{
						start: conversionStart,
						end: performance.now(),
					},
				);
				frame.current = requestAnimationFrame(() => {
					performance.measure(
						entering ? "markdown-source:enter" : "markdown-source:exit",
						{
							start: started,
							end: performance.now(),
						},
					);
				});
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
		saveNow,
		serialize,
		t,
	]);

	useLayoutEffect(() => {
		if (mode !== "source" && mode !== "rendered") return;
		const apply = restore.current;
		restore.current = null;
		apply?.();
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
