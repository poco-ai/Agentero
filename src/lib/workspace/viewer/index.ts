import { isUnderPapers } from "@/lib/paper/paths";
import { isRemoteArxivPath } from "@/lib/paper/remote-paper";
import { isResearchTablePath } from "@/lib/research-table/model";
import { isMarkdownPath } from "@/lib/vault/fs";

export function isPdfPath(path: string): boolean {
	return /\.pdf$/i.test(path);
}

export function isHtmlPath(path: string): boolean {
	return /\.html?$/i.test(path);
}

/** Excalidraw whiteboard files. */
export function isExcalidrawPath(path: string): boolean {
	return /\.excalidraw$/i.test(path);
}

/** Common image extensions previewable in the center pane. */
export function isImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(path);
}

/** MIME type for local image → blob: preview. */
export function imageMimeFromPath(path: string): string {
	const m = path.match(/\.([a-z0-9]+)$/i);
	const ext = (m?.[1] ?? "").toLowerCase();
	switch (ext) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "bmp":
			return "image/bmp";
		case "svg":
			return "image/svg+xml";
		case "avif":
			return "image/avif";
		case "ico":
			return "image/x-icon";
		default:
			return "application/octet-stream";
	}
}

/** True when a string can be used as an <img> src (blob: or remote). */
export function isImageViewerSource(
	source: string | null | undefined,
): source is string {
	if (!source?.trim()) return false;
	const s = source.trim();
	return /^(https?|blob|data):/i.test(s);
}

/**
 * One entry per document type the center workspace can show. This table is
 * the single source of truth for:
 * - the `CenterViewMode` union (derived below),
 * - path → mode inference (`preferredModeForPath`, ordered matcher scan),
 * - the persisted-session whitelist (`isCenterViewMode`),
 * - the dockview panel renderer (`renderer`),
 * - the keep-alive LRU pools (`keepAlive`, applied in workspace-host),
 * - DocView's domain-props memo mapping (`props`),
 * - the resource strategy resolved by loadTabResources (`resource`),
 * - persisted-session restore overrides (`restore`).
 *
 * Adding a document type is one entry here plus its render branch in
 * doc-view.tsx; reusing an existing `resource` strategy needs no loader or
 * persistence change.
 */
export type ViewerModeSpec = {
	/** Registry key; the `CenterViewMode` union is derived from these. */
	mode: string;
	/**
	 * Ordered path predicate for `preferredModeForPath` (first match wins).
	 * null when a mode is never inferred from a path (translation panes are
	 * created programmatically as clones of a source paper pane).
	 */
	matchesPath: ((path: string) => boolean) | null;
	/**
	 * dockview panel renderer. "always" keeps inactive sibling panels'
	 * React shells mounted (required by the LRU keep-alive gates in
	 * DocView); "onlyWhenVisible" frees their DOM.
	 */
	renderer: "always" | "onlyWhenVisible";
	/**
	 * Keep-alive LRU pool that keeps this mode's heavyweight content mounted
	 * while recently viewed (see workspace-host): "pdf" = PDF viewer LRU,
	 * "editor" = Markdown / plain-text editor LRU, null = no pool (content
	 * stays mounted only while its dock group exposes it).
	 */
	keepAlive: "pdf" | "editor" | null;
	/**
	 * DocView domain-props object this mode's branch consumes ("none" =
	 * renders from tab fields only). Drives the props-equality comparator;
	 * DocView's render switch hand-mirrors this field, and the pairing is
	 * pinned by test/workspace-viewer-modes.test.ts, not structurally.
	 */
	props: "editor" | "excalidraw" | "text" | "pdf" | "none";
	/**
	 * Content the pane renders / how loadTabResources resolves it:
	 * - "pdf": PDF bytes (local file, blob: URL or remote URL); translation
	 *   panes clone the source pane's bytes and reload from them.
	 * - "markdown": Markdown seed read from disk.
	 * - "html": remote paper HTML URL, or a local `.html` file served by
	 *   `agentero-html` (the loader does not inline the file).
	 * - "image": `blob:` URL from local image bytes.
	 * - "excalidraw": whiteboard JSON seed.
	 * - "text": raw text seed (CodeMirror catch-all).
	 */
	resource: "pdf" | "markdown" | "html" | "image" | "excalidraw" | "text";
	/**
	 * Persisted-session restore override (see initWorkspaceStore). Absent: a
	 * default placeholder tab that hydrates from disk. Translation panes are
	 * clones of a source paper pane: they restore as loaded paper-kind tabs
	 * and never pass through loadTabResources.
	 */
	restore?: {
		/** Tab kind assigned to the restored placeholder. */
		kind: "paper";
		/** Title shown before hydration when the persisted entry has none. */
		fallbackTitle: string;
		/** Restored tabs are already loaded — hydration must skip them. */
		loaded: boolean;
	};
};

export const VIEWER_MODE_TABLE = [
	{
		mode: "research-table",
		matchesPath: isResearchTablePath,
		renderer: "always",
		keepAlive: "editor",
		props: "text",
		resource: "text",
	},
	{
		mode: "pdf",
		matchesPath: isPdfPath,
		renderer: "always",
		keepAlive: "pdf",
		props: "pdf",
		resource: "pdf",
	},
	{
		mode: "html",
		matchesPath: isHtmlPath,
		renderer: "onlyWhenVisible",
		keepAlive: null,
		props: "none",
		resource: "html",
	},
	{
		mode: "image",
		matchesPath: isImagePath,
		renderer: "onlyWhenVisible",
		keepAlive: null,
		props: "none",
		resource: "image",
	},
	{
		mode: "excalidraw",
		matchesPath: isExcalidrawPath,
		renderer: "always",
		keepAlive: null,
		props: "excalidraw",
		resource: "excalidraw",
	},
	{
		mode: "markdown",
		matchesPath: isMarkdownPath,
		renderer: "always",
		keepAlive: "editor",
		props: "editor",
		resource: "markdown",
	},
	{
		// Rendered-translation companion of a paper pane, created by
		// createTranslationSplitPane — no path rule of its own.
		mode: "translation",
		matchesPath: null,
		renderer: "always",
		keepAlive: null,
		props: "pdf",
		resource: "pdf",
		restore: { kind: "paper", fallbackTitle: "Translation", loaded: true },
	},
	{
		// CodeMirror catch-all for files no dedicated viewer claims.
		mode: "text",
		matchesPath: null,
		renderer: "always",
		keepAlive: "editor",
		props: "text",
		resource: "text",
	},
] as const satisfies readonly ViewerModeSpec[];

/** Every document type the center workspace knows (derived from the table). */
export type CenterViewMode = (typeof VIEWER_MODE_TABLE)[number]["mode"];

const SPEC_BY_MODE = new Map<string, ViewerModeSpec>(
	VIEWER_MODE_TABLE.map((entry): [string, ViewerModeSpec] => [
		entry.mode,
		entry,
	]),
);

/** Registry entry for a mode (throws on an unregistered mode). */
export function viewerModeSpec(mode: CenterViewMode): ViewerModeSpec {
	const spec = SPEC_BY_MODE.get(mode);
	if (!spec) throw new Error(`unregistered center view mode: ${mode}`);
	return spec;
}

/** Persistence whitelist: exactly the registry modes. */
export function isCenterViewMode(v: unknown): v is CenterViewMode {
	return typeof v === "string" && SPEC_BY_MODE.has(v);
}

/** True when a dedicated viewer's path rule claims this path. */
export function isViewerPath(path: string): boolean {
	return VIEWER_MODE_TABLE.some((entry) => entry.matchesPath?.(path) === true);
}

/**
 * View mode for a path: the first registry matcher wins. Paths under
 * `papers/` fall back to Markdown — they belong to the paper's NOTES/PAPER
 * domain, and an org-level index note must never degrade into a raw text
 * buffer. Everything else falls back to the CodeMirror plain-text editor.
 */
export function preferredModeForPath(path: string | null): CenterViewMode {
	if (!path) return "markdown";
	for (const entry of VIEWER_MODE_TABLE) {
		if (entry.matchesPath?.(path)) return entry.mode;
	}
	if (isUnderPapers(path)) return "markdown";
	return "text";
}

/**
 * PDFs outside `papers/` (e.g. a compiled plans/a.pdf) render as a plain
 * viewer: no layout analysis, visual annotation, translation, selection
 * toolbar, or marks. Remote arXiv papers keep their own remote behavior.
 */
export function isPlainPdfPath(path: string | null): boolean {
	if (!path) return false;
	return !isUnderPapers(path) && !isRemoteArxivPath(path);
}

/** .tex source file outside papers/ (compilable in the file tree). */
export function isTexPath(path: string | null): boolean {
	if (!path || !/\.tex$/i.test(path)) return false;
	return !isUnderPapers(path);
}

/** Compiled output path for a .tex source: same dir, same stem, .pdf. */
export function texPdfPath(texPath: string): string {
	return texPath.replace(/\.tex$/i, ".pdf");
}

export type TextLanguageId = "json" | "yaml" | "python" | "tex" | "bib";

/**
 * Syntax-highlight language for the plain-text editor; null = plain text
 * (no highlighting, including `.txt`).
 */
export function textLanguageIdForPath(path: string): TextLanguageId | null {
	const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
	switch (ext) {
		case "json":
			return "json";
		case "yaml":
		case "yml":
			return "yaml";
		case "py":
		case "pyw":
			return "python";
		case "tex":
		case "sty":
		case "cls":
			return "tex";
		case "bib":
			return "bib";
		default:
			return null;
	}
}

/**
 * A paper body renders PDF or HTML — never a Markdown editor. When no asset
 * resolved, "pdf" shows PdfViewer's honest "no paper" empty state; an empty
 * editor here would be editable-but-broken (its edits have no file to
 * persist to).
 */
export function paperBodyMode(
	hasPdf: boolean,
	htmlUrl: string | null,
): CenterViewMode {
	return hasPdf ? "pdf" : htmlUrl ? "html" : "pdf";
}
