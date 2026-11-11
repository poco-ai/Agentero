import { Loader2 } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PapersLibrary } from "@/components/library/papers-library";
import { PlazaTabView } from "@/components/plaza/plaza-tab-view";
import { Skeleton } from "@/components/ui/skeleton";
import type { PdfViewerHandle } from "@/components/viewer";
import { HtmlViewer, ImageViewer } from "@/components/viewer";
import { LocalHtmlViewer } from "@/components/viewer/local-html-viewer";
import { RecycleBinView } from "@/components/workspace/recycle-bin-view";
import { TexProjectView } from "@/components/writing/tex-project-view";
import { useSharedWritingEditor } from "@/components/writing/writing-cloud-context";
import { useSettings } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper";
import { isRemoteArxivPath } from "@/lib/paper";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace/types";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import type { LibraryColumnPref } from "@/lib/settings";
import { isMarkdownPath, paperRelFromNotes } from "@/lib/vault";
import type { WikiRenameHeadingRequest } from "@/lib/wiki";
import {
	openWritingFile,
	rememberWritingSource,
} from "@/lib/workspace/navigation";
import { updateTab } from "@/lib/workspace/store";
import { type DocTab, tabIsPaperNotes } from "@/lib/workspace/tabs";
import {
	isHtmlPath,
	isPlainPdfPath,
	viewerModeSpec,
} from "@/lib/workspace/viewer";
import { isWritingSource } from "@/lib/workspace/writing-focus";
import {
	isWritingPath,
	resolveWritingTarget,
} from "@/lib/writing/project-target";

// Heavyweight viewers are lazy-loaded so the EmbedPDF (PDFium) and Plate
// editor bundles stay out of the initial chunk and are fetched on first use.
const PdfViewer = lazy(() =>
	import("@/components/viewer/pdf/pdf-viewer").then((m) => ({
		default: m.PdfViewer,
	})),
);
const MarkdownEditor = lazy(() =>
	import("@/components/editor").then((m) => ({
		default: m.MarkdownEditor,
	})),
);
const ExcalidrawViewer = lazy(() =>
	import("@/components/viewer/excalidraw-viewer").then((m) => ({
		default: m.ExcalidrawViewer,
	})),
);

const TableViewer = lazy(() =>
	import("@/components/research-table/table-viewer").then((m) => ({
		default: m.TableViewer,
	})),
);
const TextEditor = lazy(() =>
	import("@/components/viewer/text-editor").then((m) => ({
		default: m.TextEditor,
	})),
);
const TexLiveViewer = lazy(() =>
	import("@/components/viewer/texlive/tex-live-viewer").then((m) => ({
		default: m.TexLiveViewer,
	})),
);

/** Library-tab-only props (ignored by PDF / editor / trash). */
export type DocViewLibraryProps = {
	papers: PaperLibraryRow[];
	loading: boolean;
	query: string;
	onQueryChange: (query: string) => void;
	/** Vault-relative folder scope; null = full library. */
	scopePath: string | null;
	columns: LibraryColumnPref[];
	onColumnsChange: (columns: LibraryColumnPref[]) => void;
	rescanning: boolean;
	onOpenPaper: (paper: PaperMetadata) => void;
	onRescan: () => void;
};

/** Markdown / NOTES editor props. */
export type DocViewEditorProps = {
	fontSize: number;
	/** CSS font-family stack; omit/undefined keeps app theme font. */
	fontFamily?: string;
	/** Unitless line-height for body text. */
	lineHeight?: number;
	showToolbar: boolean;
	notesPlaceholder: string;
	markdownPlaceholder: string;
	onPersistFile: (
		path: string,
		md: string,
		lastSaved: string,
		tabId: string,
	) => Promise<boolean>;
	onResolveMarkdownConflict?: (
		tabId: string,
		action: "keep" | "load" | "hold",
		disk: string,
	) => void;
	onAssetsChanged: () => void;
	onTabPatch: (id: string, patch: Partial<DocTab>) => void;
	onRenameHeading?: (
		path: string,
		request: Omit<WikiRenameHeadingRequest, "path">,
	) => Promise<void>;
};

/** PDF viewer props. */
export type DocViewPdfProps = {
	onOpenSettings: () => void;
	registerHandle: (tabId: string, handle: PdfViewerHandle | null) => void;
	onHighlightsChange: (tabId: string, list: PdfHighlight[]) => void;
	onAsksChange: (tabId: string, list: PdfAskThread[]) => void;
	onVisualTracesChange: (tabId: string, list: PdfVisualSessionTrace[]) => void;
	/**
	 * Open a rendered-translation tab split to the right of the current PDF panel.
	 * Called by the full-document translate button when dual-pane mode is on.
	 */
	onOpenTranslationTab?: (
		paperTabId: string,
		paperAbsPath: string | null,
		paperTitle?: string | null,
	) => void;
};

/** Excalidraw editor props. */
export type DocViewExcalidrawProps = {
	onPersistFile: (
		path: string,
		json: string,
		lastSaved: string,
	) => Promise<boolean>;
	onTabPatch: (id: string, patch: Partial<DocTab>) => void;
};

/** Plain-text (CodeMirror) editor props. */
export type DocViewTextProps = {
	onPersistFile: (
		path: string,
		content: string,
		lastSaved: string,
	) => Promise<boolean>;
	/** ⌘S manual save: flush landed — TeX compiles here, others no-op. */
	onManualSave: (path: string) => void;
	onTabPatch: (id: string, patch: Partial<DocTab>) => void;
};

export type DocViewProps = {
	/** Primary tab or split pane (shared fields). */
	tab: DocTab;
	active: boolean;
	/**
	 * Whether this tab should stay mounted even when inactive (LRU of recently
	 * viewed PDFs / Markdown editors, plus every group-visible panel). When
	 * false and inactive, the heavyweight content (PDF viewer or Plate editor)
	 * unmounts — PDF releases its engine document, the editor drops back to a
	 * placeholder. State needed for restore is persisted on the tab.
	 */
	keepMounted: boolean;
	vaultPath: string | null;
	library: DocViewLibraryProps;
	editor: DocViewEditorProps;
	pdf: DocViewPdfProps;
	excalidraw: DocViewExcalidrawProps;
	text: DocViewTextProps;
	onTrashChanged: () => void;
	/** Bump to reload recycle bin after Empty Recycle Bin from the sidebar. */
	trashReloadSignal?: number;
};

function TabLoadingSkeleton() {
	return (
		<div
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden bg-muted/20 p-4"
			aria-busy="true"
			role="status"
		>
			<Skeleton className="library-shimmer h-8 w-2/5" />
			<div className="flex min-h-0 flex-1 flex-col gap-3 rounded-md border bg-background/40 p-4">
				<Skeleton className="library-shimmer h-4 w-3/4" />
				<Skeleton className="library-shimmer h-3 w-full" />
				<Skeleton className="library-shimmer h-3 w-11/12" />
				<Skeleton className="library-shimmer h-3 w-4/5" />
				<div className="mt-4 space-y-3">
					<Skeleton className="library-shimmer h-3 w-full" />
					<Skeleton className="library-shimmer h-3 w-5/6" />
					<Skeleton className="library-shimmer h-3 w-2/3" />
				</div>
			</div>
		</div>
	);
}

/**
 * Compiled-PDF pane while its LaTeX compile is still running: a minimal
 * centered hint (the bytes do not exist on disk yet).
 */
function TexCompilingPlaceholder() {
	const { t } = useTranslation("app");
	return (
		<div
			className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6"
			aria-busy="true"
			role="status"
		>
			<Skeleton className="library-shimmer h-3.5 w-28" />
			<p className="text-muted-foreground text-xs">{t("tabs.texCompiling")}</p>
		</div>
	);
}

function TexCompilingIndicator() {
	const { t } = useTranslation("app");
	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none absolute bottom-12 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-xs shadow-raised"
		>
			<Loader2
				className="size-3.5 animate-spin motion-reduce:animate-none"
				aria-hidden
			/>
			{t("tabs.texCompiling")}
		</div>
	);
}

/**
 * DocView routes by tab kind/mode and only reads the matching domain props.
 * Compare just the fields the active branch consumes so a change in one
 * domain (e.g. library query keystrokes) does not re-render PDF / editor
 * panes. The mode → props-domain mapping comes from the viewer registry
 * (`props` in viewer/index.ts) — a hand-written mirror of the render switch
 * below whose correspondence is pinned by
 * test/workspace-viewer-modes.test.ts, not enforced structurally.
 */
function docViewPropsEqual(prev: DocViewProps, next: DocViewProps): boolean {
	if (
		prev.tab !== next.tab ||
		prev.active !== next.active ||
		prev.keepMounted !== next.keepMounted ||
		prev.vaultPath !== next.vaultPath
	) {
		return false;
	}
	const tab = next.tab;
	if (!tab.loaded) return true;
	if (tab.kind === "library") return prev.library === next.library;
	if (tab.kind === "trash") {
		return (
			prev.onTrashChanged === next.onTrashChanged &&
			prev.trashReloadSignal === next.trashReloadSignal
		);
	}
	if (tab.kind === "plaza") return true;
	switch (viewerModeSpec(tab.mode).props) {
		case "editor":
			return prev.editor === next.editor;
		case "excalidraw":
			return prev.excalidraw === next.excalidraw;
		case "text":
			return prev.text === next.text;
		case "pdf":
			return prev.pdf === next.pdf;
		case "none":
			return true;
	}
}

/** Document content router by tab.kind / mode (library, trash, editor, PDF, image, HTML). */
const DocumentContent = memo(function DocumentContent({
	tab,
	active,
	keepMounted,
	vaultPath,
	library,
	editor,
	pdf,
	excalidraw,
	text,
	onTrashChanged,
	trashReloadSignal = 0,
}: DocViewProps) {
	const plazaEnabled = useSettings((s) => s.plazaEnabled);
	const cloud = useSharedWritingEditor(tab.path);
	// Bind tab.id once per tab so PdfViewer's memo bails out when only the tab
	// record changes (highlight / ask patches via updateTab).
	const handlePdfHandle = useCallback(
		(handle: PdfViewerHandle | null) => pdf.registerHandle(tab.id, handle),
		[pdf, tab.id],
	);
	const handlePdfHighlightsChange = useCallback(
		(list: PdfHighlight[]) => pdf.onHighlightsChange(tab.id, list),
		[pdf, tab.id],
	);
	const handlePdfAsksChange = useCallback(
		(list: PdfAskThread[]) => pdf.onAsksChange(tab.id, list),
		[pdf, tab.id],
	);
	const handlePdfVisualTracesChange = useCallback(
		(list: PdfVisualSessionTrace[]) => pdf.onVisualTracesChange(tab.id, list),
		[pdf, tab.id],
	);
	const isNotes = tabIsPaperNotes(tab);
	const handleEditorPersist = useCallback(
		(path: string, md: string, lastSaved: string) =>
			editor.onPersistFile(path, md, lastSaved, tab.id),
		[editor.onPersistFile, tab.id],
	);
	// Stable identity: an inline lambda here is a new prop on every DocView
	// render, which defeats the memo boundary around MarkdownEditor.
	const handleEditorDirtyChange = useCallback(
		(dirty: boolean) => {
			editor.onTabPatch(
				tab.id,
				isNotes ? { notesDirty: dirty } : { markdownDirty: dirty },
			);
		},
		[editor.onTabPatch, isNotes, tab.id],
	);
	if (tab.texLive) {
		if (!active && !keepMounted) return null;
		const texRoot = tab.texRoot ?? tab.path.replace(/\.pdf$/i, ".tex");
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<TexLiveViewer
						rootPath={texRoot}
						vaultPath={vaultPath}
						active={active}
					/>
				</Suspense>
			</div>
		);
	}
	if (tab.texCompiling && !tab.pdfBytes && !tab.pdfUrl) {
		if (!active && !keepMounted) return null;
		return <TexCompilingPlaceholder />;
	}
	if (!tab.loaded) {
		if (!active && !keepMounted) return null;
		return <TabLoadingSkeleton />;
	}
	if (tab.kind === "library") {
		return (
			<PapersLibrary
				papers={library.papers}
				vaultPath={vaultPath}
				active={active}
				loading={library.loading}
				query={library.query}
				onQueryChange={library.onQueryChange}
				scopePath={library.scopePath}
				columns={library.columns}
				onColumnsChange={library.onColumnsChange}
				onOpenPaper={library.onOpenPaper}
				onRescan={library.onRescan}
				rescanning={library.rescanning}
				className="bg-background"
			/>
		);
	}
	if (tab.kind === "trash") {
		return (
			<RecycleBinView
				vaultPath={vaultPath}
				active={active}
				onChanged={onTrashChanged}
				reloadSignal={trashReloadSignal}
				className="bg-background"
			/>
		);
	}
	if (tab.kind === "plaza") {
		if (!plazaEnabled) return null;
		// The tab owns its embedded page until close, independent of the editor LRU.
		return (
			<Suspense fallback={<TabLoadingSkeleton />}>
				<PlazaTabView
					key={`${tab.id}:${tab.path}`}
					path={tab.path}
					active={active}
					className="bg-background"
				/>
			</Suspense>
		);
	}
	if (tab.mode === "markdown") {
		// PERF: same keep-alive gate as PDF. Dockview keeps the panel shell
		// mounted (`renderer: 'always'` in dock-workspace); the workspace host
		// LRU (`keepMounted`) decides whether the heavyweight Plate editor stays
		// alive. Evicted editors unmount (their pending autosave flushes on
		// unmount) and re-deserialize from the seed when shown again.
		if (
			!active &&
			!keepMounted &&
			!(isNotes ? tab.notesDirty : tab.markdownDirty)
		)
			return null;
		return (
			<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/30">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<MarkdownEditor
						// Stable per-tab key: external disk changes reload in place via
						// `reloadKey` instead of remounting the whole editor.
						key={isNotes ? `notes-center-${tab.id}` : `file-${tab.id}`}
						className="h-full min-h-0"
						tabId={tab.id}
						active={active}
						initialMarkdown={isNotes ? tab.notesSeed : tab.markdownSeed}
						reloadKey={isNotes ? tab.notesKey : tab.seedKey}
						filePath={
							isNotes
								? tab.notesPath
								: isMarkdownPath(tab.path)
									? tab.path
									: null
						}
						navigationIntent={tab.navigationIntent}
						fontSize={editor.fontSize}
						fontFamily={editor.fontFamily}
						lineHeight={editor.lineHeight}
						showToolbar={editor.showToolbar}
						placeholder={
							isNotes ? editor.notesPlaceholder : editor.markdownPlaceholder
						}
						onPersist={handleEditorPersist}
						saveConflict={tab.markdownConflict}
						onResolveSaveConflict={editor.onResolveMarkdownConflict}
						onAssetsChanged={editor.onAssetsChanged}
						onRenameHeading={editor.onRenameHeading}
						onDirtyChange={handleEditorDirtyChange}
					/>
				</Suspense>
			</div>
		);
	}
	if (tab.mode === "pdf") {
		// PERF: dockview keeps PDF panel shells mounted (`renderer: 'always'` in
		// dock-workspace) so inactive siblings stay in the React tree. We still
		// gate the heavyweight EmbedPDF viewer with App-level PDF LRU
		// (`keepMounted`): only the active tab + a few recently viewed PDFs
		// keep PDFium documents alive (main-thread cost). Older inactive PDFs
		// return null here to release the engine; position / annotations / ask
		// threads are persisted and restore on remount.
		if (!active && !keepMounted) return null;
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<PdfViewer
						source={tab.pdfUrl}
						sourceBytes={tab.pdfBytes}
						docId={tab.id}
						paperAbsPath={
							tab.notesPath
								? tab.notesPath.replace(/[\\/]NOTES\.md$/i, "")
								: null
						}
						paperRelPath={
							tab.paperMeta?.path ?? paperRelFromNotes(tab.notesPath, vaultPath)
						}
						vaultPath={vaultPath}
						paperMeta={tab.paperMeta}
						isActive={active}
						isRemotePaper={isRemoteArxivPath(tab.path)}
						plainViewer={isPlainPdfPath(tab.path)}
						texRootPath={tab.texRoot}
						pdfPath={tab.path}
						importIdentifier={tab.paperMeta?.source_url ?? undefined}
						onOpenSettings={pdf.onOpenSettings}
						className="h-full w-full"
						onHandle={handlePdfHandle}
						onHighlightsChange={handlePdfHighlightsChange}
						onAsksChange={handlePdfAsksChange}
						onVisualTracesChange={handlePdfVisualTracesChange}
						onOpenTranslationTab={pdf.onOpenTranslationTab}
					/>
				</Suspense>
				{tab.texCompiling && <TexCompilingIndicator />}
			</div>
		);
	}
	if (tab.mode === "translation") {
		// Render the same PDF page stack as the source, but keep this pane read-only
		// and chrome-free so it only shows the translation overlay.
		if (!active && !keepMounted) return null;
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<PdfViewer
						source={tab.pdfUrl}
						sourceBytes={tab.pdfBytes}
						docId={tab.id}
						paperAbsPath={
							tab.notesPath
								? tab.notesPath.replace(/[\\/]NOTES\.md$/i, "")
								: null
						}
						paperRelPath={
							tab.paperMeta?.path ?? paperRelFromNotes(tab.notesPath, vaultPath)
						}
						vaultPath={vaultPath}
						paperMeta={tab.paperMeta}
						isActive={active}
						isRemotePaper={isRemoteArxivPath(tab.path)}
						importIdentifier={tab.paperMeta?.source_url ?? undefined}
						onOpenSettings={pdf.onOpenSettings}
						className="h-full w-full"
						onHandle={handlePdfHandle}
						onHighlightsChange={handlePdfHighlightsChange}
						onAsksChange={handlePdfAsksChange}
						onVisualTracesChange={handlePdfVisualTracesChange}
						translationPane
						translationOnly
					/>
				</Suspense>
			</div>
		);
	}
	if (tab.mode === "image") {
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<ImageViewer
					source={tab.imageUrl}
					alt={tab.title}
					className="h-full w-full"
				/>
			</div>
		);
	}
	if (tab.mode === "excalidraw") {
		if (!active && !keepMounted) return <TabLoadingSkeleton />;
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<ExcalidrawViewer
						// Stable per-tab key: external disk changes reload in place
						// via `reloadKey` instead of remounting the whole viewer.
						key={`excalidraw-${tab.id}`}
						seed={tab.excalidrawSeed}
						path={tab.path}
						reloadKey={tab.excalidrawKey}
						onPersist={excalidraw.onPersistFile}
						onDirtyChange={(d) =>
							excalidraw.onTabPatch(tab.id, { excalidrawDirty: d })
						}
						className="h-full w-full"
					/>
				</Suspense>
			</div>
		);
	}
	if (tab.mode === "research-table") {
		if (!active && !keepMounted) return <TabLoadingSkeleton />;
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<TableViewer
						key={tab.id}
						path={tab.path}
						seed={tab.textSeed}
						reloadKey={tab.textKey}
						vaultPath={vaultPath}
						onPersist={text.onPersistFile}
						onDirtyChange={(dirty) =>
							text.onTabPatch(tab.id, { textDirty: dirty })
						}
					/>
				</Suspense>
			</div>
		);
	}
	if (tab.mode === "text") {
		if (cloud.pending || (cloud.session && !cloud.shared))
			return <TabLoadingSkeleton />;
		// Same keep-alive gate as the Markdown editor: an evicted tab's
		// unmount flushes its pending autosave; remount re-seeds from disk.
		if (!active && !keepMounted) return <TabLoadingSkeleton />;
		const source = (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<TextEditor
						// Stable per-tab key: external disk changes swap the document
						// in place via `reloadKey` (view state and scroll survive).
						key={`text-${tab.id}-${cloud.shared ? (cloud.shared.readOnly ? "cloud-view" : "cloud-edit") : "local"}`}
						shared={cloud.shared ?? undefined}
						panelId={tab.id}
						hideLintFooter={isWritingSource(tab, vaultPath)}
						seed={tab.textSeed}
						path={tab.path}
						reloadKey={tab.textKey}
						active={active}
						onPersist={text.onPersistFile}
						onManualSave={text.onManualSave}
						onDirtyChange={(d) => text.onTabPatch(tab.id, { textDirty: d })}
						className="h-full w-full"
					/>
				</Suspense>
			</div>
		);
		return source;
	}
	// HTML pages. Do not create their iframe (and therefore do not start a
	// request) until the panel is actually activated. A `.html` file in the
	// vault is a local preview; a paper body with `htmlUrl` stays remote.
	if (!active) return null;
	if (isHtmlPath(tab.path)) {
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<LocalHtmlViewer
					path={tab.path}
					reloadKey={tab.htmlKey}
					title={tab.title}
					className="h-full w-full"
				/>
			</div>
		);
	}
	return (
		<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
			<HtmlViewer
				srcUrl={tab.htmlUrl}
				title={tab.title}
				className="h-full w-full"
				onShowPdf={
					tab.paperMeta?.type === "html"
						? undefined
						: () => updateTab(tab.id, { mode: "pdf" })
				}
			/>
		</div>
	);
}, docViewPropsEqual);

/** The project frame belongs to every project file, independent of viewer mode. */
export function DocView(props: DocViewProps) {
	const { tab, vaultPath, active, keepMounted } = props;
	useEffect(() => {
		if (active && tab.writingRoot)
			rememberWritingSource(tab.path, tab.writingRoot);
	}, [active, tab.path, tab.writingRoot]);
	useEffect(() => {
		if (
			!active ||
			!vaultPath ||
			tab.writingRoot ||
			!isWritingPath(vaultPath, tab.path)
		)
			return;
		let cancelled = false;
		void resolveWritingTarget(vaultPath, tab.path)
			.then((project) => {
				if (cancelled || !project) return;
				if (project.compiledPdf) openWritingFile(tab.path, project.root, true);
				else updateTab(tab.id, { writingRoot: project.root });
			})
			.catch((error) => {
				if (!cancelled) notifyError(errorText(error));
			});
		return () => {
			cancelled = true;
		};
	}, [active, vaultPath, tab.id, tab.path, tab.writingRoot]);
	const content = <DocumentContent {...props} />;
	if (vaultPath && tab.writingRoot && (active || keepMounted)) {
		return (
			<TexProjectView
				panelId={tab.id}
				sourcePath={tab.path}
				projectRoot={tab.writingRoot}
				vaultPath={vaultPath}
				active={active}
			>
				{content}
			</TexProjectView>
		);
	}
	return content;
}
