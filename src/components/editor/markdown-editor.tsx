"use client";

import { MarkdownPlugin } from "@platejs/markdown";
import { ImagePlugin } from "@platejs/media/react";
import { TocPlugin } from "@platejs/toc/react";
import { Plate, usePlateEditor } from "platejs/react";
import {
	type KeyboardEvent,
	lazy,
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
import { ImageElement } from "@/components/editor/nodes/block/image-node";
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
import { convertBlockquoteMarkerToCallout } from "@/components/editor/plugins/callout-plugin";
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
import { useLibraryStore } from "@/hooks/use-app-stores";
import i18n from "@/i18n";
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
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
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { saveImageToMarkdownAssets } from "@/lib/markdown/image";
import { loadSettings } from "@/lib/settings";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import type { LinkFragment, WikiRenameHeadingRequest } from "@/lib/wiki";
import { useWikiNav } from "@/lib/wiki/nav-context";
import {
	findWikiHeadingIndex,
	hasWikiBlockAnchor,
} from "@/lib/wiki-navigation";

export type MarkdownEditorProps = {
	/** Initial Markdown content for the open file. The component reseeds on remount (key). */
	initialMarkdown: string;
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

export function MarkdownEditor({
	initialMarkdown,
	filePath,
	readOnly,
	placeholder,
	className,
	fontSize,
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
	/** Swallow the `beforeinput` insertParagraph that follows slash Enter confirm. */
	const suppressNextEditorBreakRef = useRef(false);
	const [findOpen, setFindOpen] = useState(false);
	const [findFocusTick, setFindFocusTick] = useState(0);
	const [exportOpen, setExportOpen] = useState(false);
	const [exportBusy, setExportBusy] = useState(false);
	const [exportPaperHeader, setExportPaperHeader] =
		useState<MarkdownExportPaperHeader | null>(null);
	const [exportDefaultWatermark, setExportDefaultWatermark] = useState(false);
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
		target.dataset.navTarget = "true";
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		const timeout = window.setTimeout(() => {
			delete target.dataset.navTarget;
		}, 1600);
		return () => window.clearTimeout(timeout);
	}, [navigationIntent]);

	/**
	 * ImagePlugin must declare `uploadImage` in its initial options store.
	 * Plate `setOption` only accepts keys already present — configure at plugin
	 * creation (refs keep the handler current without recreating the editor).
	 */
	const plugins = useMemo(
		() => [
			...MarkdownEditorKit,
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
			return ed
				.getApi(MarkdownPlugin)
				.markdown.deserialize(prepareMarkdownForDeserialize(body || " "));
		},
	});

	const {
		frontmatterYaml,
		onFrontmatterChange: handleFrontmatterChange,
		serialize,
		noteDocumentChanged,
		saveNow,
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
		consumePresentationMarkdown,
		handleWikiLinkBoundaryBeforeInput,
		handleWikiLinkArrow,
		handleWikiLinkBoundaryDelete,
		handleWikiLinkDraftEnter,
		handleWikiLinkCompositionStart,
		handleWikiLinkCompositionEnd,
		finalizeWikiLinkDrafts,
	} = useWikilinkEditing({ editor, serialize, suppressNextEditorBreakRef });

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			const target = event.target;
			const isEditorTarget =
				target instanceof HTMLElement &&
				target.closest("[data-slate-editor]") !== null &&
				target.closest("input, textarea, select, [contenteditable='false']") ===
					null;
			if (!isEditorTarget) return;

			if (!event.nativeEvent.isComposing) {
				if (
					(event.metaKey || event.ctrlKey) &&
					!event.shiftKey &&
					!event.altKey &&
					event.key.toLowerCase() === "a"
				) {
					// Handle Select All before browser/Slate default handling so
					// the editor selection and the native DOM selection stay in sync.
					event.preventDefault();
					event.stopPropagation();
					const scrollRoot = editorContainerRef.current;
					const scrollTop = scrollRoot?.scrollTop ?? 0;
					const scrollLeft = scrollRoot?.scrollLeft ?? 0;
					editor.tf.selectAll();
					if (scrollRoot) {
						// The selection focus is the document end, so Plate may
						// scroll there while synchronizing the native selection.
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
			finalizeWikiLinkDrafts();
		},
		[closeMenus, finalizeWikiLinkDrafts],
	);

	const {
		selectionExpanded: contextMenuSelectionExpanded,
		onContextMenu: handleEditorContextMenu,
		onOpenChange: handleContextMenuOpenChange,
		copy: handleContextMenuCopy,
		cut: handleContextMenuCut,
		paste: handleContextMenuPaste,
		insertLink: insertContextMenuLink,
		formatMarkdown: handleContextMenuFormatMarkdown,
		formatting: formattingMarkdown,
		headingContext,
		renameOpen: headingRenameOpen,
		setRenameOpen: setHeadingRenameOpen,
		renameBusy: headingRenameBusy,
		confirmRename: confirmHeadingRename,
	} = useEditorContextMenu({
		editor,
		editorContainerRef,
		readOnly,
		serialize,
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
	});

	const handleEditorValueChange = useCallback(() => {
		const presentationMarkdown = consumePresentationMarkdown();
		if (presentationMarkdown !== null) {
			scheduleCompletionProbe();
			scheduleWikiLinkPresentationSync();
			if (serialize() === presentationMarkdown) return;
		}
		handleChange();
		scheduleWikiLinkPresentationSync();
	}, [
		consumePresentationMarkdown,
		handleChange,
		scheduleCompletionProbe,
		scheduleWikiLinkPresentationSync,
		serialize,
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
		setExportDefaultWatermark(loadSettings().exportWatermarkEnabled);
		setExportOpen(true);
	}, [filePath, paperMetaByRelPath, wikiNav?.vaultPath]);

	const handleExportConfirm = useCallback(
		async (options: MarkdownExportOptions) => {
			if (exportInFlightRef.current) return;
			exportInFlightRef.current = true;
			const gen = exportGenerationRef.current;
			setExportBusy(true);
			try {
				const result = await runMarkdownExport({
					markdown: serialize(),
					filePath: filePath ?? null,
					vaultPath: wikiNav?.vaultPath ?? null,
					mdFiles: wikiNav?.mdFiles,
					defaultName: exportDefaultName(filePath ?? null, exportPaperHeader),
					options,
					paperHeader: exportPaperHeader,
				});
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
							<div className="relative min-h-0 min-w-0 flex-1">
								<ContextMenu onOpenChange={handleContextMenuOpenChange}>
									<ContextMenuTrigger asChild>
										<EditorContainer
											ref={editorContainerRef}
											className="agentero-scroll h-full min-w-0 overflow-y-auto"
											onScrollCapture={() => {
												// Reposition instead of hard-dismiss: arrow-key list
												// updates can reflow and fire scroll without leaving [[.
												scheduleCompletionProbe();
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
												placeholder={placeholder}
												readOnly={readOnly}
												className="min-h-full px-6 pt-4 pb-48"
												style={fontSize ? { fontSize } : undefined}
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
												!contextMenuCapabilities.formatMarkdown ||
												formattingMarkdown
											}
											onSelect={() => {
												void handleContextMenuFormatMarkdown();
											}}
										>
											{i18n.t(
												formattingMarkdown
													? "editor:contextMenu.formatMarkdownBusy"
													: "editor:contextMenu.formatMarkdown",
											)}
										</ContextMenuItem>
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
							defaultWatermark={exportDefaultWatermark}
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
}
