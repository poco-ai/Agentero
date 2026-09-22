import { isUnderPapers } from "@/lib/paper/paths";
import { isRemoteArxivPath } from "@/lib/paper/remote-paper";
import { isMarkdownPath } from "@/lib/vault/fs";

export type CenterViewMode =
	| "markdown"
	| "pdf"
	| "html"
	| "image"
	| "translation"
	| "excalidraw"
	| "text";

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
 * View mode for a path. After the dedicated viewers (PDF / HTML / image /
 * Excalidraw / Markdown), CodeMirror is the fallback, including paper source
 * and attachment files. Only Markdown files belong in the rich-text editor:
 * parsing structured data such as citation JSON there can block the UI.
 */
export function preferredModeForPath(path: string | null): CenterViewMode {
	if (!path) return "markdown";
	if (isPdfPath(path)) return "pdf";
	if (isHtmlPath(path)) return "html";
	if (isImagePath(path)) return "image";
	if (isExcalidrawPath(path)) return "excalidraw";
	if (isMarkdownPath(path)) return "markdown";
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
