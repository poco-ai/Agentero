/**
 * Hover-preview classification for PDF external links (#1212).
 *
 * Classification is purely URL-based: no network probe happens here. The card
 * starts a proxy request only for what this returns, and falls back to the
 * full-address tip when the actual response cannot be framed / decoded.
 *
 * - `image`: inline formats every supported webview can decode (`<img>`).
 * - `page`: an `http(s)` target the `agentero-web` proxy may try to frame.
 * - `none`: not previewable — non-web schemes, PDFs (the reader already shows
 *   them) and known binary downloads keep the URL tip.
 */

export type LinkPreviewKind = "page" | "image" | "none";

/** What the hover card should load, and from which URL. */
export type LinkPreviewTarget = {
	kind: LinkPreviewKind;
	/** Resolved URL: a direct image for figure permalinks, else the link target. */
	url: string;
};

/** Inline image formats; `.tif/.tiff/.heic` deliberately fall back to the tip. */
const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"bmp",
	"svg",
]);

/**
 * Targets a framed preview cannot show usefully: PDFs stay with the reader,
 * and binary downloads would only yield the browser's download chrome.
 */
const NON_PREVIEW_EXTENSIONS = new Set([
	"pdf",
	"tif",
	"tiff",
	"zip",
	"gz",
	"tar",
	"rar",
	"7z",
	"dmg",
	"exe",
	"pkg",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"epub",
	"mp4",
	"mov",
	"mp3",
	"wav",
]);

/** Lowercase extension of the last path segment, or null when there is none. */
function pathExtension(pathname: string): string | null {
	const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
	const dot = segment.lastIndexOf(".");
	if (dot <= 0 || dot === segment.length - 1) return null;
	return segment.slice(dot + 1).toLowerCase();
}

/** Parsed `http(s)` URL, or null for anything the preview must leave alone. */
export function httpUrl(raw: string): URL | null {
	try {
		const url = new URL(raw.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

/**
 * PDF endpoints often have no extension (`arxiv.org/pdf/2401.00001`,
 * `openreview.net/pdf?id=…`); a framed preview of those would only nest the
 * browser's PDF viewer, so keep the URL tip instead.
 */
function looksLikePdfPath(pathname: string): boolean {
	return pathname
		.toLowerCase()
		.split("/")
		.some((segment) => segment === "pdf" || segment === "pdfs");
}

/**
 * eLife figure permalinks (`/articles/<id>/figures#fig4s1`) are HTML pages that
 * show a single figure; the proxy cannot fetch them (eLife answers non-browser
 * clients with a challenge), but the same figure is a direct CDN JPG. Prefer
 * the image so a figure-supplement link previews as its actual figure.
 */
function elifeFigureImage(url: URL): string | null {
	if (!/(^|\.)elifesciences\.org$/i.test(url.hostname)) return null;
	const article = url.pathname.match(/^\/articles\/(\d+)(?:\/figures)?\/?$/i);
	if (!article) return null;
	const anchor = decodeURIComponent(url.hash.replace(/^#/, ""));
	const figure = anchor.match(/^fig(\d+)(?:s(\d+))?$/i);
	if (!figure) return null;
	const id = article[1];
	const name = figure[2]
		? `fig${figure[1]}-figsupp${figure[2]}`
		: `fig${figure[1]}`;
	return `https://cdn.elifesciences.org/articles/${id}/elife-${id}-${name}-v1.jpg`;
}

/** Which hover card an external link should open, from its URL alone. */
export function classifyLinkPreview(raw: string): LinkPreviewKind {
	const url = httpUrl(raw);
	if (!url) return "none";
	// The `agentero-web` proxy always fetches https on the default port, so a
	// custom-port target would preview a different resource. Keep the URL tip.
	if (url.port) return "none";
	const extension = pathExtension(url.pathname);
	if (extension && IMAGE_EXTENSIONS.has(extension)) return "image";
	if (
		(extension && NON_PREVIEW_EXTENSIONS.has(extension)) ||
		looksLikePdfPath(url.pathname)
	)
		return "none";
	return "page";
}

/**
 * Resolve the hover card target. Most links keep their URL; eLife figure
 * permalinks resolve to the directly hosted figure image.
 */
export function resolveLinkPreviewTarget(raw: string): LinkPreviewTarget {
	const url = httpUrl(raw);
	if (!url) return { kind: "none", url: raw.trim() };
	const image = elifeFigureImage(url);
	if (image) return { kind: "image", url: image };
	return { kind: classifyLinkPreview(raw), url: url.href };
}
