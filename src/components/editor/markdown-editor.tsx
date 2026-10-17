"use client";

import { ImagePlugin } from "@platejs/media/react";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { TocPlugin } from "@platejs/toc/react";
import type { SlateEditor } from "platejs";
import { Plate, usePlateEditor, usePluginOption } from "platejs/react";
import {
	type CSSProperties,
	type KeyboardEvent,
	lazy,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MarkdownDocProvider } from "@/components/editor/context/markdown-doc-context";
import { Editor, EditorContainer } from "@/components/editor/editor-surface";
import { WikiEmbedProjectionProvider } from "@/components/editor/embeds/projection-context";
import { useCompletionDrafts } from "@/components/editor/hooks/use-completion-drafts";
import { useEditorContextMenu } from "@/components/editor/hooks/use-editor-context-menu";
import { useMarkdownPersistence } from "@/components/editor/hooks/use-markdown-persistence";
import { useSelectionContextPublish } from "@/components/editor/hooks/use-selection-context-publish";
import { useWikilinkEditing } from "@/components/editor/hooks/use-wikilink-editing";
import { MarkdownExportDialog } from "@/components/editor/markdown-export-dialog";
import { MarkdownExportSurface } from "@/components/editor/markdown-export-surface";
import { BlockDragStateBridge } from "@/components/editor/nodes/block/block-draggable";
import { ImageElement } from "@/components/editor/nodes/block/image-node";
import { EditorStatusBar } from "@/components/editor/overlays/editor-status-bar";
import { FindReplaceBar } from "@/components/editor/overlays/find-replace-bar";
import { FrontmatterPanel } from "@/components/editor/overlays/frontmatter-panel";
import { HeadingRenameDialog } from "@/components/editor/overlays/heading-rename-dialog";
import { SlashCommandMenu } from "@/components/editor/overlays/slash-command-menu";
import {
	MINIMUM_TOC_HEADINGS,
	queryTocHeadings,
	TocSidebar,
} from "@/components/editor/overlays/toc-sidebar";
import { WikiLinkSuggestion } from "@/components/editor/overlays/wiki-link-suggestion";
import { BlockSelectionKit } from "@/components/editor/plugins/block-selection-kit";
import { convertBlockquoteMarkerToCallout } from "@/components/editor/plugins/callout-plugin";
import { DndKit } from "@/components/editor/plugins/dnd-kit";
import { MarkdownEditorKit } from "@/components/editor/plugins/markdown-editor-kit";
import { MarkdownEditorToolbar } from "@/components/editor/toolbar/markdown-toolbar";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLibraryStore, useSettings } from "@/hooks/use-app-stores";
import i18n from "@/i18n";
import { scrollBehavior } from "@/lib/core/motion";
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import {
	insertBreakAfterSelectedVoidBlocks,
	selectCurrentBlockThenAll,
	selectTopLevelBlockThenAll,
} from "@/lib/markdown/block-selection";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { editorContextMenuCapabilities } from "@/lib/markdown/editor-context-menu";
import {
	exportDefaultName,
	resolveExportPaperHeader,
	runMarkdownExport,
} from "@/lib/markdown/export";
import type {
	MarkdownExportOptions,
	MarkdownExportPaperHeader,
} from "@/lib/markdown/export/types";
import { splitFrontmatter, wrapFrontmatter } from "@/lib/markdown/frontmatter";
import { saveImageToMarkdownAssets } from "@/lib/markdown/image";
import { convertInlineMathAtCaret } from "@/lib/markdown/inline-math-auto-close";
import { registerMarkdownSelectionLinesProvider } from "@/lib/markdown/markdown-selection-lines-registry";
import {
	getMarkdownScrollTop,
	setMarkdownScrollTop,
} from "@/lib/markdown/scroll-memory";
import { resolveSelectionSourceLines } from "@/lib/markdown/selection-source-lines";
import { useUiScale } from "@/lib/settings";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import type { LinkFragment, WikiRenameHeadingRequest } from "@/lib/wiki";
import { useWikiNav } from "@/lib/wiki/nav-context";
import {
	findWikiHeadingIndex,
	hasWikiBlockAnchor,
} from "@/lib/wiki/navigation";

export type MarkdownEditorProps = {
	/** Initial Markdown content for the open file. Reloaded in place when `reloadKey` bumps. */
	initialMarkdown: string;
	/**
	 * Bump to reload `initialMarkdown` in place (external/Agent disk write the
	 * tab layer already accepted). Unlike a remount, plugins, DOM and scroll
	 * position survive the reload.
	 */
	reloadKey?: number;
	/**
	 * Absolute path this editor instance persists to. Captured for the lifetime of the
	 * instance (parent keys the editor per file), so autosave and unmount-flush always
	 * write to the correct file even when switching files quickly. Null disables saving.
	 */
	filePath?: string | null;
	readOnly?: boolean;
	placeholder?: string;
	className?: string;
	fontSize?: number | string;
	/** CSS font-family stack for body text; omit to keep app theme font. */
	fontFamily?: string;
	/** Unitless line-height for body text. */
	lineHeight?: number;
	/** Show the WYSIWYG formatting toolbar above the editor. */
	showToolbar?: boolean;
	/**
	 * Persist serialized Markdown (frontmatter re-attached) to `path`.
	 * `lastSaved` is the content currently believed to be on disk (the previous
	 * persist / load seed) so the host can detect external modifications and avoid
	 * silently overwriting them.
	 */
	onPersist?: (
		path: string,
		markdown: string,
		lastSaved: string,
	) => Promise<boolean>;
	onDirtyChange?: (dirty: boolean) => void;
	/** After writing an image under `./assets/` (refresh file tree). */
	onAssetsChanged?: () => void;
	/** Explicitly rename one saved heading and repair its inbound fragments. */
	onRenameHeading?: (
		path: string,
		request: Omit<WikiRenameHeadingRequest, "path">,
	) => Promise<void>;
	/** A one-shot request to scroll to a resolved internal-link anchor. */
	navigationIntent?: { id: number; fragment: LinkFragment };
};

const EmbeddedMarkdownProjection = lazy(async () => {
	const module = await import(
		"@/components/editor/embeds/embedded-markdown-projection"
	);
	return { default: module.EmbeddedMarkdownProjection };
});

/** Re-publish Agent selection chips when the block-selection set changes. */
function BlockSelectionPublishBridge({ onChange }: { onChange: () => void }) {
	const selectedIds = usePluginOption(BlockSelectionPlugin, "selectedIds");
	useEffect(() => {
		void selectedIds;
		onChange();
	}, [onChange, selectedIds]);
	return null;
}

/**
 * Headings are top-level blocks, so this counts them without touching leaves —
 * far cheaper than the full walks TocSidebar performs once mounted.
 */
function hasEnoughHeadings(children: readonly unknown[]): boolean {
	let count = 0;
	for (const node of children) {
		const type = (node as { type?: unknown }).type;
		if (typeof type !== "string" || !/^h[1-6]$/.test(type)) continue;
		count += 1;
		if (count >= MINIMUM_TOC_HEADINGS) return true;
	}
	return false;
}

/** Cmd+A inside a non-editable island (Mermaid preview, embed card) selects that block. */
function selectEnclosingTopBlock(
	editor: SlateEditor,
	target: HTMLElement,
): boolean {
	const host = target.closest("[data-slate-node='element']");
	if (!host) return false;
	const node = editor.api.toSlateNode(host);
	if (!node) return false;
	const path = editor.api.findPath(node);
	if (!path) return false;
	return selectTopLevelBlockThenAll(editor, path);
}

/**
 * Shallow-compares every prop except `initialMarkdown`, which only counts
 * when `reloadKey` changes too: the seed is consumed solely at mount and by
 * the reload effect (which early-outs while `reloadKey` is unchanged). The
 * tab layer rewrites the seed after each save sync (`syncTabSeedsForPath`),
 * and without this comparator those seed-only patches would reconcile the
 * whole editor chrome on every autosave.
 */
function markdownEditorPropsEqual(
	prev: MarkdownEditorProps,
	next: MarkdownEditorProps,
): boolean {
	for (const key of Object.keys(next) as (keyof MarkdownEditorProps)[]) {
		if (key === "initialMarkdown") continue;
		if (prev[key] !== next[key]) return false;
	}
	if (prev.initialMarkdown !== next.initialMarkdown) {
		// A new seed matters only when it comes with a reload signal.
		return prev.reloadKey === next.reloadKey;
	}
	return true;
}

/**
 * Memoized on its props: the workspace re-renders every pane's DocView on
 * tab patches (active tab, dirty flags, PDF compile state), and an
 * unmemoized editor paid a full Plate reconcile each time.
 */
export const MarkdownEditor = memo(function MarkdownEditor({
	initialMarkdown,
	reloadKey,
	filePath,
	readOnly,
	placeholder,
	className,
	fontSize,
	fontFamily,
	lineHeight,
	showToolbar,
	onPersist,
	onDirtyChange,
	onAssetsChanged,
	onRenameHeading,
	navigationIntent,
}: MarkdownEditorProps) {
	const filePathRef = useRef(filePath ?? null);
	filePathRef.current = filePath ?? null;
	const onAssetsChangedRef = useRef(onAssetsChanged);
	onAssetsChangedRef.current = onAssetsChanged;
	const editorContainerRef = useRef<HTMLDivElement | null>(null);
	// Reading position survives keep-alive eviction (see scroll-memory).
	const scrollKey = filePath ?? null;
	const scrollTopRef = useRef(0);
	// Body text keeps its own px font size (editorFontSize setting) so it must
	// follow the UI zoom (uiScale) explicitly — rem-based chrome scales for free.
	const uiScale = useUiScale();
	const markdownMaxWidth = useSettings((s) => s.markdownMaxWidth);

	/**
	 * Body typography on the editor root. When a custom font stack is set, also
	 * rebind --font-sans / --font-heading so headings (font-heading) follow body
	 * text. Code blocks keep font-mono / --font-mono and are not overridden.
	 */
	const editorTypographyStyle = useMemo((): CSSProperties | undefined => {
		const style: CSSProperties = {};
		if (fontSize != null && fontSize !== "") {
			style.fontSize =
				typeof fontSize === "number" ? fontSize * uiScale : fontSize;
		}
		if (lineHeight != null && Number.isFinite(lineHeight)) {
			style.lineHeight = lineHeight;
		}
		if (fontFamily) {
			style.fontFamily = fontFamily;
			// Scope theme font tokens so headings using font-heading follow body.
			(style as Record<string, string>)["--font-sans"] = fontFamily;
			(style as Record<string, string>)["--font-heading"] = fontFamily;
		}
		if (markdownMaxWidth > 0) {
			style.maxWidth = markdownMaxWidth;
		}
		return Object.keys(style).length > 0 ? style : undefined;
	}, [fontSize, fontFamily, lineHeight, uiScale, markdownMaxWidth]);
	/** Swallow the `beforeinput` insertParagraph that follows slash Enter confirm. */
	const suppressNextEditorBreakRef = useRef(false);
	const [findOpen, setFindOpen] = useState(false);
	const [findFocusTick, setFindFocusTick] = useState(0);
	const [exportOpen, setExportOpen] = useState(false);
	const [exportBusy, setExportBusy] = useState(false);
	const [exportPaperHeader, setExportPaperHeader] =
		useState<MarkdownExportPaperHeader | null>(null);
	/** Bumped on unmount so in-flight export does not setState after leave. */
	const exportGenerationRef = useRef(0);
	const exportInFlightRef = useRef(false);
	const wikiNav = useWikiNav();
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);

	useEffect(
		() => () => {
			exportGenerationRef.current += 1;
		},
		[],
	);

	/**
	 * Set while a navigation jump owns the scroll position. The scroll-memory
	 * restore below runs one frame later, and its synchronous `scrollTop` write
	 * cancels the in-flight smooth scroll — which used to yank the view back
	 * to the remembered offset right after a `[[note#heading]]` jump.
	 */
	const navigationJumpRef = useRef(false);

	useEffect(() => {
		if (!navigationIntent) return;
		const root = editorContainerRef.current;
		if (!root) return;
		const fragment = navigationIntent.fragment;
		// Annotation fragments jump in the PDF viewer, not the Markdown editor.
		if (fragment.kind === "annotation") return;
		const headings = [
			...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"),
		];
		const target =
			fragment.kind === "heading"
				? headings[
						findWikiHeadingIndex(
							headings.map((element) => ({
								level: Number(element.tagName.slice(1)),
								text: element.textContent ?? "",
							})),
							fragment.path,
						)
					]
				: [...root.querySelectorAll<HTMLElement>("p,li,blockquote,td")].find(
						(element) =>
							hasWikiBlockAnchor(element.textContent ?? "", fragment.id),
					);
		if (!target) return;
		navigationJumpRef.current = true;
		target.dataset.navTarget = "true";
		target.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
		const timeout = window.setTimeout(() => {
			delete target.dataset.navTarget;
			navigationJumpRef.current = false;
		}, 1600);
		return () => {
			navigationJumpRef.current = false;
			window.clearTimeout(timeout);
		};
	}, [navigationIntent]);

	/**
	 * ImagePlugin must declare `uploadImage` in its initial options store.
	 * Plate `setOption` only accepts keys already present — configure at plugin
	 * creation (refs keep the handler current without recreating the editor).
	 */
	const plugins = useMemo(
		() => [
			...MarkdownEditorKit,
			// After CalloutPlugin so block Cmd+A wraps the callout override.
			...BlockSelectionKit,
			...DndKit,
			TocPlugin.configure({
				options: { queryHeading: queryTocHeadings },
			}),
			ImagePlugin.configure({
				options: {
					uploadImage: async (dataUrl: ArrayBuffer | string) => {
						const path = filePathRef.current;
						if (!path) {
							const err = new Error(i18n.t("editor:image.noFile"));
							notifyError(err.message);
							throw err;
						}
						try {
							const rel = await saveImageToMarkdownAssets(path, dataUrl);
							onAssetsChangedRef.current?.();
							return rel;
						} catch (e) {
							notifyError(errorMessage(e));
							throw e;
						}
					},
				},
			}).withComponent(ImageElement),
		],
		[],
	);

	const editor = usePlateEditor({
		plugins,
		value: (ed) => {
			const { body } = splitFrontmatter(initialMarkdown);
			return deserializeMarkdownBody(ed, body);
		},
	});

	const {
		frontmatterYaml,
		onFrontmatterChange: persistFrontmatterChange,
		serialize,
		noteDocumentChanged,
		saveNow,
		applyExternalMarkdown,
		savedRef,
		dirtyRef,
	} = useMarkdownPersistence({
		editor,
		initialMarkdown,
		filePath,
		readOnly,
		onPersist,
		onDirtyChange,
		filePathRef,
		onAssetsChangedRef,
	});
	const frontmatterYamlRef = useRef(frontmatterYaml);
	frontmatterYamlRef.current = frontmatterYaml;
	/** Bumps when body or frontmatter changes — keys Plate source-line cache. */
	const docVersionRef = useRef(0);
	const handleFrontmatterChange = useCallback(
		(interior: string) => {
			docVersionRef.current += 1;
			persistFrontmatterChange(interior);
		},
		[persistFrontmatterChange],
	);

	/**
	 * External disk change accepted by the tab layer (applyDiskChange / Agent
	 * write): the parent bumps `reloadKey` alongside `initialMarkdown`. Reload
	 * in place — a keyed remount would re-init every plugin, re-deserialize the
	 * whole document and drop scroll/caret on each streamed Agent write.
	 */
	const reloadKeyRef = useRef(reloadKey);
	useEffect(() => {
		if (reloadKey === undefined || reloadKey === reloadKeyRef.current) return;
		reloadKeyRef.current = reloadKey;
		const container = editorContainerRef.current;
		const scrollTop = container?.scrollTop ?? 0;
		if (!applyExternalMarkdown(initialMarkdown)) return;
		docVersionRef.current += 1;
		scrollTopRef.current = scrollTop;
		window.requestAnimationFrame(() => {
			const el = editorContainerRef.current;
			if (el) el.scrollTop = scrollTop;
		});
	}, [reloadKey, initialMarkdown, applyExternalMarkdown]);

	// Restore the last reading position when a keep-alive-evicted note remounts,
	// and persist it (bounded, no re-render) when this instance unmounts.
	useEffect(() => {
		if (!scrollKey) return;
		const frame = window.requestAnimationFrame(() => {
			const el = editorContainerRef.current;
			if (!el) return;
			// A navigation jump owns the position this frame; restoring the
			// remembered offset would cancel its (smooth) scroll.
			if (navigationJumpRef.current) {
				scrollTopRef.current = el.scrollTop;
				return;
			}
			const top = getMarkdownScrollTop(scrollKey);
			if (top > 0) el.scrollTop = top;
			scrollTopRef.current = el.scrollTop;
		});
		return () => {
			window.cancelAnimationFrame(frame);
			setMarkdownScrollTop(scrollKey, scrollTopRef.current);
		};
	}, [scrollKey]);

	const {
		wikiCompletionDraft,
		slashCommandDraft,
		completionControllerRef,
		slashCommandControllerRef,
		scheduleCompletionProbe,
		handleMenuKeyDown,
		setWikiCompletionDraft,
		setSlashCommandDraft,
		closeMenus,
	} = useCompletionDrafts({ editor, editorContainerRef });

	const [tocMounted, setTocMounted] = useState(false);
	const refreshTocMounted = useCallback(() => {
		setTocMounted(hasEnoughHeadings(editor.children));
	}, [editor]);
	useEffect(refreshTocMounted, [refreshTocMounted]);

	const handleChange = useCallback(() => {
		scheduleCompletionProbe();
		noteDocumentChanged();
		refreshTocMounted();
	}, [noteDocumentChanged, refreshTocMounted, scheduleCompletionProbe]);

	const {
		syncWikiLinkPresentation,
		scheduleWikiLinkPresentationSync,
		consumePresentationChange,
		handleWikiLinkBoundaryBeforeInput,
		handleWikiLinkArrow,
		handleWikiLinkBoundaryDelete,
		handleWikiLinkDraftEnter,
		handleWikiLinkCompositionStart,
		handleWikiLinkCompositionEnd,
		finalizeWikiLinkDrafts,
	} = useWikilinkEditing({ editor, suppressNextEditorBreakRef });

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			if (target.closest("[data-slate-editor]") === null) return;
			// Find bar, callout title, equation source: native select-all.
			if (target.closest("input, textarea, select") !== null) return;
			const inNonEditable =
				target.closest("[contenteditable='false']") !== null;

			if (!event.nativeEvent.isComposing) {
				if (
					(event.metaKey || event.ctrlKey) &&
					!event.shiftKey &&
					!event.altKey &&
					event.key.toLowerCase() === "a"
				) {
					// Current top-level block first (code / Mermaid preview / callout),
					// then every block. Plate's selectAll treats a caret in a nested
					// code_line as "already selected" and jumps to the whole note.
					event.preventDefault();
					event.stopPropagation();
					const scrollRoot = editorContainerRef.current;
					const scrollTop = scrollRoot?.scrollTop ?? 0;
					const scrollLeft = scrollRoot?.scrollLeft ?? 0;
					const selected = inNonEditable
						? selectEnclosingTopBlock(editor, target) ||
							selectCurrentBlockThenAll(editor)
						: selectCurrentBlockThenAll(editor);
					if (!selected) editor.tf.selectAll();
					if (scrollRoot) {
						// Selecting through the document end can scroll the note there
						// while Plate synchronizes the native selection.
						const restoreScroll = () => {
							scrollRoot.scrollTop = scrollTop;
							scrollRoot.scrollLeft = scrollLeft;
						};
						restoreScroll();
						window.requestAnimationFrame(() => {
							restoreScroll();
							window.requestAnimationFrame(restoreScroll);
						});
					}
					return;
				}
				if (inNonEditable) return;
				if (handleMenuKeyDown(event)) {
					event.stopPropagation();
					return;
				}
				if (handleWikiLinkBoundaryDelete(event)) {
					event.stopPropagation();
					return;
				}
				if (handleWikiLinkArrow(event)) {
					event.stopPropagation();
					return;
				}
				if (handleWikiLinkDraftEnter(event)) {
					event.stopPropagation();
					return;
				}
				if (event.key === "Enter" && convertInlineMathAtCaret(editor)) {
					event.preventDefault();
					event.stopPropagation();
					return;
				}
				if (event.key === "Enter" && convertBlockquoteMarkerToCallout(editor)) {
					event.preventDefault();
					event.stopPropagation();
					return;
				}
				if (event.key === "Escape") {
					closeMenus();
					setFindOpen(false);
				}
			}
			// Mermaid preview and other non-editable islands stay out of find/save.
			if (inNonEditable) return;
			if (
				(event.metaKey || event.ctrlKey) &&
				!event.shiftKey &&
				!event.altKey &&
				event.key.toLowerCase() === "f"
			) {
				event.preventDefault();
				event.stopPropagation();
				setFindOpen(true);
				setFindFocusTick((tick) => tick + 1);
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				saveNow();
			}
		},
		[
			editor,
			handleWikiLinkArrow,
			handleWikiLinkBoundaryDelete,
			handleWikiLinkDraftEnter,
			saveNow,
			handleMenuKeyDown,
			closeMenus,
		],
	);

	// The block-selection shadow input portals to document.body, so editor
	// key capture never sees its events; intercept plain Enter there and
	// break out below block-selected voids (hr / image).
	useEffect(() => {
		if (readOnly) return;
		const handleShadowInputEnter = (event: globalThis.KeyboardEvent) => {
			if (
				event.key !== "Enter" ||
				event.isComposing ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey ||
				!(event.target instanceof HTMLElement) ||
				!event.target.classList.contains("slate-shadow-input")
			) {
				return;
			}
			if (insertBreakAfterSelectedVoidBlocks(editor)) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		document.addEventListener("keydown", handleShadowInputEnter, true);
		return () =>
			document.removeEventListener("keydown", handleShadowInputEnter, true);
	}, [editor, readOnly]);

	const handleEditorBlur = useCallback(
		(event: React.FocusEvent<HTMLDivElement>) => {
			if (event.currentTarget.contains(event.relatedTarget)) return;
			// Completion menus portal to document.body — focus moving into them
			// must not dismiss the list (arrow/click interaction).
			const related = event.relatedTarget;
			if (
				related instanceof Element &&
				related.closest("[data-editor-completion]")
			) {
				return;
			}
			closeMenus();
			convertInlineMathAtCaret(editor);
			finalizeWikiLinkDrafts();
		},
		[closeMenus, editor, finalizeWikiLinkDrafts],
	);

	const {
		selectionExpanded: contextMenuSelectionExpanded,
		onContextMenu: handleEditorContextMenu,
		onOpenChange: handleContextMenuOpenChange,
		copy: handleContextMenuCopy,
		cut: handleContextMenuCut,
		paste: handleContextMenuPaste,
		insertLink: insertContextMenuLink,
		headingContext,
		renameOpen: headingRenameOpen,
		setRenameOpen: setHeadingRenameOpen,
		renameBusy: headingRenameBusy,
		confirmRename: confirmHeadingRename,
	} = useEditorContextMenu({
		editor,
		editorContainerRef,
		readOnly,
		savedRef,
		dirtyRef,
		filePathRef,
		onRenameHeading,
		scheduleCompletionProbe,
	});

	const docCtx = useMemo(
		() => ({
			filePath: filePath ?? null,
			onAssetsChanged,
		}),
		[filePath, onAssetsChanged],
	);

	const scheduleSelectionContextPublish = useSelectionContextPublish({
		editor,
		filePathRef,
		frontmatterYamlRef,
		docVersionRef,
	});

	useEffect(() => {
		const path = filePath?.trim();
		if (!path) return;
		return registerMarkdownSelectionLinesProvider(path, {
			resolve: () =>
				resolveSelectionSourceLines({
					editor,
					frontmatter: wrapFrontmatter(frontmatterYamlRef.current),
					docVersion: docVersionRef.current,
				}),
		});
	}, [editor, filePath]);

	const handleEditorValueChange = useCallback(() => {
		// Presentation-only projection batch (wikilink source/display swap):
		// keep the document clean — no dirty flag, no autosave — without
		// serializing the whole document to find that out.
		if (consumePresentationChange()) {
			scheduleCompletionProbe();
			scheduleWikiLinkPresentationSync();
			return;
		}
		docVersionRef.current += 1;
		handleChange();
		scheduleWikiLinkPresentationSync();
	}, [
		consumePresentationChange,
		handleChange,
		scheduleCompletionProbe,
		scheduleWikiLinkPresentationSync,
	]);
	const openExportDialog = useCallback(() => {
		if (!isTauri()) {
			notifyError(i18n.t("editor:export.desktopOnly"));
			return;
		}
		const header = resolveExportPaperHeader({
			filePath: filePath ?? null,
			vaultPath: wikiNav?.vaultPath ?? null,
			paperMetaByRelPath,
		});
		setExportPaperHeader(header);
		setExportOpen(true);
	}, [filePath, paperMetaByRelPath, wikiNav?.vaultPath]);

	const handleExportConfirm = useCallback(
		async (options: MarkdownExportOptions) => {
			if (exportInFlightRef.current) return;
			exportInFlightRef.current = true;
			const gen = exportGenerationRef.current;
			setExportBusy(true);
			try {
				const result = await runMarkdownExport(
					{
						markdown: serialize(),
						filePath: filePath ?? null,
						vaultPath: wikiNav?.vaultPath ?? null,
						mdFiles: wikiNav?.mdFiles,
						defaultName: exportDefaultName(filePath ?? null, exportPaperHeader),
						options,
						paperHeader: exportPaperHeader,
					},
					MarkdownExportSurface,
				);
				if (gen !== exportGenerationRef.current) return;
				if (result.status === "cancelled") return;
				notifySuccess(i18n.t("editor:export.success"));
				setExportOpen(false);
			} catch (error) {
				if (gen !== exportGenerationRef.current) return;
				notifyError(i18n.t("editor:export.failed"), {
					description: errorMessage(error),
				});
			} finally {
				exportInFlightRef.current = false;
				if (gen === exportGenerationRef.current) {
					setExportBusy(false);
				}
			}
		},
		[
			exportPaperHeader,
			filePath,
			serialize,
			wikiNav?.mdFiles,
			wikiNav?.vaultPath,
		],
	);

	const contextMenuCapabilities = editorContextMenuCapabilities({
		exportAvailable: isTauri(),
		headingRenameAvailable: Boolean(headingContext),
		readOnly: Boolean(readOnly),
		selectionExpanded: contextMenuSelectionExpanded,
	});

	return (
		<WikiEmbedProjectionProvider component={EmbeddedMarkdownProjection}>
			<MarkdownDocProvider value={docCtx}>
				<Plate
					editor={editor}
					onSelectionChange={() => {
						syncWikiLinkPresentation(editor.selection);
						// Re-anchor or dismiss completion from caret moves (not only
						// document edits) so arrow navigation cannot leave a stale menu.
						scheduleCompletionProbe();
						scheduleSelectionContextPublish();
					}}
					onValueChange={handleEditorValueChange}
				>
					<BlockSelectionPublishBridge
						onChange={scheduleSelectionContextPublish}
					/>
					<BlockDragStateBridge />
					<div
						className={cn(
							"flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
							className,
						)}
					>
						{showToolbar && !readOnly ? (
							<MarkdownEditorToolbar
								onOpenFind={() => {
									setFindOpen(true);
									setFindFocusTick((tick) => tick + 1);
								}}
								onExport={isTauri() ? openExportDialog : undefined}
								propertiesPanel={
									<FrontmatterPanel
										value={frontmatterYaml}
										readOnly={readOnly}
										onChange={readOnly ? undefined : handleFrontmatterChange}
									/>
								}
							/>
						) : null}
						<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
							{/*
							 * `@container/editor` deliberately sits on this child rather than
							 * on the pane above. A query container that resizes re-runs style
							 * for its whole subtree on every frame of a drag — measured at 24
							 * of the 25ms a pane resize costs on WebKit. One level in, the
							 * width is still the pane's, and `markdown-resize-freeze` can pin
							 * it for the gesture so neither the query nor the text re-wraps.
							 */}
							<div
								className="@container/editor relative min-h-0 min-w-0 flex-1"
								data-editor-query-container=""
							>
								<ContextMenu onOpenChange={handleContextMenuOpenChange}>
									<ContextMenuTrigger asChild>
										<EditorContainer
											ref={editorContainerRef}
											className="agentero-scroll h-full min-w-0 overflow-y-auto"
											onScrollCapture={() => {
												const el = editorContainerRef.current;
												if (el) scrollTopRef.current = el.scrollTop;
												// Reposition instead of hard-dismiss: arrow-key list
												// updates can reflow and fire scroll without leaving [[.
												// Only probe while a menu is open — the probe reads the
												// DOM and walks the editor tree, which per scroll event
												// makes scrollbar dragging janky on large notes.
												if (wikiCompletionDraft || slashCommandDraft) {
													scheduleCompletionProbe();
												}
											}}
											onMouseDownCapture={(event) => {
												if (
													event.button === 2 &&
													window.getSelection()?.toString() &&
													event.currentTarget.contains(
														window.getSelection()?.anchorNode ?? null,
													)
												)
													event.preventDefault();
											}}
											onContextMenuCapture={handleEditorContextMenu}
											onKeyDownCapture={readOnly ? undefined : handleKeyDown}
											onBeforeInputCapture={
												readOnly ? undefined : handleWikiLinkBoundaryBeforeInput
											}
											onBlur={readOnly ? undefined : handleEditorBlur}
											onCompositionStartCapture={
												readOnly ? undefined : handleWikiLinkCompositionStart
											}
											onCompositionEndCapture={
												readOnly ? undefined : handleWikiLinkCompositionEnd
											}
										>
											{/*
											 * min-h-full + generous bottom padding so the last line is easy
											 * to click and Enter can always create a new block below it
											 * (matches Plate default variant pb-72).
											 */}
											<Editor
												data-selection-chat-source={filePath || undefined}
												data-selection-chat-origin="markdown"
												placeholder={placeholder}
												readOnly={readOnly}
												// `pl-10` leaves room for the block drag handle
												// (`-translate-x-full` in the left gutter).
												// `pr-14` reserves a right gutter for the collapsed
												// TOC strip (`right-2 w-10`) so it never covers text.
												// Narrow panes hide that strip, so the gutter goes too.
												className={cn(
													"min-h-full pl-10 pr-14 pt-4 pb-48 @max-2xs/editor:pr-6 [&>*:first-child]:mt-0",
													markdownMaxWidth > 0 && "mx-auto w-full",
												)}
												style={editorTypographyStyle}
											/>
											{!readOnly ? (
												<WikiLinkSuggestion
													draft={wikiCompletionDraft}
													onClose={() => setWikiCompletionDraft(null)}
													onContinue={(raw) =>
														setWikiCompletionDraft((current) =>
															current ? { ...current, raw } : current,
														)
													}
													controllerRef={completionControllerRef}
												/>
											) : null}
											{!readOnly ? (
												<SlashCommandMenu
													draft={slashCommandDraft}
													onClose={() => setSlashCommandDraft(null)}
													controllerRef={slashCommandControllerRef}
													onCommandExecuted={() => {
														suppressNextEditorBreakRef.current = true;
														// Clear if beforeinput never arrives (some engines).
														window.setTimeout(() => {
															suppressNextEditorBreakRef.current = false;
														}, 100);
													}}
												/>
											) : null}
										</EditorContainer>
									</ContextMenuTrigger>
									<ContextMenuContent className="w-56">
										<ContextMenuItem
											disabled={!contextMenuCapabilities.cut}
											onSelect={() => {
												void handleContextMenuCut();
											}}
										>
											{i18n.t("editor:contextMenu.cut")}
											<ContextMenuShortcut>
												{formatModShortcut("x")}
											</ContextMenuShortcut>
										</ContextMenuItem>
										<ContextMenuItem
											disabled={!contextMenuCapabilities.copy}
											onSelect={() => {
												void handleContextMenuCopy();
											}}
										>
											{i18n.t("editor:contextMenu.copy")}
											<ContextMenuShortcut>
												{formatModShortcut("c")}
											</ContextMenuShortcut>
										</ContextMenuItem>
										<ContextMenuItem
											disabled={!contextMenuCapabilities.paste}
											onSelect={() => {
												void handleContextMenuPaste();
											}}
										>
											{i18n.t("editor:contextMenu.paste")}
											<ContextMenuShortcut>
												{formatModShortcut("v")}
											</ContextMenuShortcut>
										</ContextMenuItem>
										<ContextMenuSeparator />
										<ContextMenuItem
											disabled={
												!contextMenuCapabilities.exportNote || exportBusy
											}
											onSelect={() => {
												openExportDialog();
											}}
										>
											{i18n.t("editor:contextMenu.exportNote")}
										</ContextMenuItem>
										<ContextMenuSeparator />
										<ContextMenuItem
											disabled={!contextMenuCapabilities.insertLink}
											onSelect={() => insertContextMenuLink("wiki")}
										>
											{i18n.t("editor:contextMenu.insertWikiLink")}
										</ContextMenuItem>
										<ContextMenuItem
											disabled={!contextMenuCapabilities.insertLink}
											onSelect={() => insertContextMenuLink("external")}
										>
											{i18n.t("editor:contextMenu.insertExternalLink")}
										</ContextMenuItem>
										<ContextMenuSeparator />
										<ContextMenuItem
											disabled={!contextMenuCapabilities.renameHeading}
											onSelect={() => {
												if (headingContext) setHeadingRenameOpen(true);
											}}
										>
											{i18n.t("editor:headingRename.menu")}
										</ContextMenuItem>
									</ContextMenuContent>
								</ContextMenu>
								{findOpen && !readOnly ? (
									<FindReplaceBar
										focusTick={findFocusTick}
										onClose={() => {
											setFindOpen(false);
											editor.tf.focus();
										}}
									/>
								) : null}
								{tocMounted ? (
									<TocSidebar rootMargin="-8px 0px -80% 0px" topOffset={16} />
								) : null}
							</div>
						</div>
						<EditorStatusBar
							filePath={filePath}
							vaultPath={wikiNav?.vaultPath ?? null}
						/>
						<HeadingRenameDialog
							open={headingRenameOpen}
							heading={headingContext}
							busy={headingRenameBusy}
							onOpenChange={setHeadingRenameOpen}
							onConfirm={confirmHeadingRename}
						/>
						<MarkdownExportDialog
							open={exportOpen}
							busy={exportBusy}
							paperHeader={exportPaperHeader}
							onCancel={() => {
								if (!exportBusy) setExportOpen(false);
							}}
							onConfirm={(options) => {
								void handleExportConfirm(options);
							}}
						/>
					</div>
				</Plate>
			</MarkdownDocProvider>
		</WikiEmbedProjectionProvider>
	);
}, markdownEditorPropsEqual);
