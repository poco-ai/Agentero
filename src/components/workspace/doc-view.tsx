import { lazy, memo, Suspense, useCallback } from "react";
import { PapersLibrary } from "@/components/library/papers-library";
import { Skeleton } from "@/components/ui/skeleton";
import type { PdfViewerHandle } from "@/components/viewer";
import { HtmlViewer, ImageViewer } from "@/components/viewer";
import { RecycleBinView } from "@/components/workspace/recycle-bin-view";
import { useSettings } from "@/hooks/use-app-stores";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper";
import { isRemoteArxivPath } from "@/lib/paper";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace/types";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import type { LibraryColumnPref } from "@/lib/settings";
import { isMarkdownPath, paperRelFromNotes } from "@/lib/vault";
import type { WikiRenameHeadingRequest } from "@/lib/wiki";
import { type DocTab, tabIsPaperNotes } from "@/lib/workspace/tabs";

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
const PlazaView = lazy(() =>
	import("@/components/plaza/plaza-view").then((m) => ({
		default: m.PlazaView,
	})),
);
const TranslationView = lazy(() =>
	import("@/components/translation/translation-view").then((m) => ({
		default: m.TranslationView,
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
	) => Promise<boolean>;
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
 * DocView routes by tab kind/mode and only reads the matching domain props.
 * Compare just the fields the active branch consumes so a change in one
 * domain (e.g. library query keystrokes) does not re-render PDF / editor
 * panes. Must mirror the routing order below.
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
	if (tab.mode === "markdown") return prev.editor === next.editor;
	if (tab.mode === "pdf") return prev.pdf === next.pdf;
	if (tab.mode === "translation") return true;
	return true;
}

/** Document content router by tab.kind / mode (library, trash, editor, PDF, image, HTML). */
export const DocView = memo(function DocView({
	tab,
	active,
	keepMounted,
	vaultPath,
	library,
	editor,
	pdf,
	onTrashChanged,
	trashReloadSignal = 0,
}: DocViewProps) {
	const plazaEnabled = useSettings((s) => s.plazaEnabled);
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
	if (!tab.loaded) {
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
				className="bg-muted/20"
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
				className="bg-muted/20"
			/>
		);
	}
	if (tab.kind === "plaza") {
		if (!plazaEnabled) return null;
		// Embedded remote site: don't mount (and don't start its requests) until active.
		if (!active) return null;
		return (
			<Suspense fallback={<TabLoadingSkeleton />}>
				<PlazaView path={tab.path} className="bg-muted/20" />
			</Suspense>
		);
	}
	const isNotes = tabIsPaperNotes(tab);
	if (tab.mode === "markdown") {
		// PERF: same keep-alive gate as PDF. Dockview keeps the panel shell
		// mounted (`renderer: 'always'` in dock-workspace); the workspace host
		// LRU (`keepMounted`) decides whether the heavyweight Plate editor stays
		// alive. Evicted editors unmount (their pending autosave flushes on
		// unmount) and re-deserialize from the seed when shown again.
		if (!active && !keepMounted) return <TabLoadingSkeleton />;
		return (
			<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/30">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<MarkdownEditor
						// Stable per-tab key: external disk changes reload in place via
						// `reloadKey` instead of remounting the whole editor.
						key={isNotes ? `notes-center-${tab.id}` : `file-${tab.id}`}
						className="h-full min-h-0"
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
						onPersist={editor.onPersistFile}
						onAssetsChanged={editor.onAssetsChanged}
						onRenameHeading={editor.onRenameHeading}
						onDirtyChange={(d) =>
							editor.onTabPatch(
								tab.id,
								isNotes ? { notesDirty: d } : { markdownDirty: d },
							)
						}
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
			</div>
		);
	}
	if (tab.mode === "translation") {
		return (
			<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<TranslationView paperAbsPath={tab.path} />
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
	// HTML pages are remote documents. Do not create their iframe (and therefore
	// do not start a network request) until the panel is actually activated.
	if (!active) return null;
	return (
		<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
			<HtmlViewer srcUrl={tab.htmlUrl} className="h-full w-full" />
		</div>
	);
}, docViewPropsEqual);
