import { lazy, memo, Suspense } from "react";
import { PapersLibrary } from "@/components/library/papers-library";
import { Skeleton } from "@/components/ui/skeleton";
import type { PdfViewerHandle } from "@/components/viewer/embed/pdf-viewer";
import { HtmlViewer } from "@/components/viewer/html-viewer";
import { ImageViewer } from "@/components/viewer/image-viewer";
import { RecycleBinView } from "@/components/workspace/recycle-bin-view";
import type { PaperMetadata } from "@/lib/paper";
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
	import("@/components/viewer/embed/pdf-viewer").then((m) => ({
		default: m.PdfViewer,
	})),
);
const MarkdownEditor = lazy(() =>
	import("@/components/editor").then((m) => ({
		default: m.MarkdownEditor,
	})),
);

/** Library-tab-only props (ignored by PDF / editor / trash). */
export type DocViewLibraryProps = {
	papers: PaperMetadata[];
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
	onOpenAnnotations: () => void;
	onOpenSettings: () => void;
	registerHandle: (tabId: string, handle: PdfViewerHandle | null) => void;
	onHighlightsChange: (tabId: string, list: PdfHighlight[]) => void;
	onAsksChange: (tabId: string, list: PdfAskThread[]) => void;
	onVisualTracesChange: (tabId: string, list: PdfVisualSessionTrace[]) => void;
};

export type DocViewProps = {
	/** Primary tab or split pane (shared fields). */
	tab: DocTab;
	active: boolean;
	/**
	 * Whether this PDF tab should stay mounted even when inactive (LRU of
	 * recently viewed PDFs). Non-PDF tabs ignore this. When false and inactive,
	 * the heavyweight PDF viewer unmounts to release its engine document.
	 */
	pdfKeepMounted: boolean;
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

/** Document content router by tab.kind / mode (library, trash, editor, PDF, image, HTML). */
export const DocView = memo(function DocView({
	tab,
	active,
	pdfKeepMounted,
	vaultPath,
	library,
	editor,
	pdf,
	onTrashChanged,
	trashReloadSignal = 0,
}: DocViewProps) {
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
	const isNotes = tabIsPaperNotes(tab);
	if (tab.mode === "markdown") {
		return (
			<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/30">
				<Suspense fallback={<TabLoadingSkeleton />}>
					<MarkdownEditor
						key={
							isNotes
								? `notes-center-${tab.id}-${tab.notesKey}`
								: `file-${tab.id}-${tab.seedKey}`
						}
						className="h-full min-h-0"
						initialMarkdown={isNotes ? tab.notesSeed : tab.markdownSeed}
						filePath={
							isNotes
								? tab.notesPath
								: isMarkdownPath(tab.path)
									? tab.path
									: null
						}
						navigationIntent={tab.navigationIntent}
						fontSize={editor.fontSize}
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
		// (`pdfKeepMounted`): only the active tab + a few recently viewed PDFs
		// keep PDFium documents alive (main-thread cost). Older inactive PDFs
		// return null here to release the engine; position / annotations / ask
		// threads are persisted and restore on remount.
		if (!active && !pdfKeepMounted) return null;
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
						isActive={active}
						onOpenAnnotations={pdf.onOpenAnnotations}
						onOpenSettings={pdf.onOpenSettings}
						className="h-full w-full"
						onHandle={(h) => pdf.registerHandle(tab.id, h)}
						onHighlightsChange={(list) => pdf.onHighlightsChange(tab.id, list)}
						onAsksChange={(list) => pdf.onAsksChange(tab.id, list)}
						onVisualTracesChange={(list) =>
							pdf.onVisualTracesChange(tab.id, list)
						}
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
	// HTML pages are remote documents. Do not create their iframe (and therefore
	// do not start a network request) until the panel is actually activated.
	if (!active) return null;
	return (
		<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
			<HtmlViewer srcUrl={tab.htmlUrl} className="h-full w-full" />
		</div>
	);
});
