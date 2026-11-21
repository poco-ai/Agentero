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
 *
 * PLOS SI file permalinks (`/article/file?…&type=supplementary`) have no file
 * extension; the corpus type is on the 302 Location (`.jpg` vs `.tif` / `.pdf`)
 * on a different host (`corpus-prod.…r2.cloudflarestorage.com`). Page JS cannot
 * read that redirect (no CORS / opaque-redirect), and agentero-web follows
 * redirects only when the hop host is already allowlisted — so pointing
 * `<img>` at the journals permalink alone fails with
 * `redirect target not allowed`. Classify SI as `image`, then Host
 * `webProxyResolveImage` HEADs the permalink (no CORS), allowlists the corpus
 * host, and the card loads the **proxied Location URL** (same pattern as
 * eLife's direct CDN rewrite). TIFF/PDF resolve to null → URL tip; ImagePreview
 * stays opacity-0 until ready. Do **not** reintroduce
 * `fetch(url, { redirect: "manual" })` from the webview — it always fails.
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
 * MIME types an `<img>` (or a future Host-side probe) can show. TIFF / PDF /
 * octet-stream stay `none`.
 */
const INLINE_IMAGE_CONTENT_TYPES = new Set([
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/svg+xml",
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

/**
 * PLOS main-figure image endpoints (`…/figure/image?id=…g001`) have no file
 * extension but redirect to a browser-decodable PNG/JPEG. Keep classifying them
 * as images. Do **not** use this for SI `.s00N` (that path 404s).
 */
function plosMainFigureImage(url: URL): string | null {
	if (!/(^|\.)journals\.plos\.org$/i.test(url.hostname)) return null;
	if (!/\/article\/figure\/image\/?$/i.test(url.pathname)) return null;
	const id = url.searchParams.get("id");
	if (!id) return null;
	// SI ids end in `.s00N` — never treat those figure/image URLs as images.
	if (/\.s\d+$/i.test(id)) return null;
	return url.href;
}

/**
 * PLOS supporting-information file permalink. The path has no extension; the
 * corpus asset type is on the 302 Location (`.jpg` vs `.tif` / `.pdf`).
 */
export function isPlosSupplementaryFileUrl(raw: string): boolean {
	const url = httpUrl(raw);
	if (!url) return false;
	if (!/(^|\.)journals\.plos\.org$/i.test(url.hostname)) return false;
	if (!/\/article\/file\/?$/i.test(url.pathname)) return false;
	if (url.searchParams.get("type")?.toLowerCase() !== "supplementary") {
		return false;
	}
	return Boolean(url.searchParams.get("id"));
}

/**
 * Classify from a response Content-Type (Host / proxy probe only — not page
 * `fetch`). Only inline-decodable image MIME types become `image`.
 */
export function linkPreviewKindFromContentType(
	contentType: string | null | undefined,
): LinkPreviewKind {
	if (!contentType) return "none";
	const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (INLINE_IMAGE_CONTENT_TYPES.has(mime)) return "image";
	return "none";
}

/**
 * Classify from a redirect Location URL (Host / proxy probe only — page JS
 * cannot read PLOS opaque-redirects). `.jpg`/`.png`/`.webp` → image;
 * `.tif`/`.pdf` → none.
 */
export function linkPreviewKindFromRedirectLocation(
	location: string | null | undefined,
): LinkPreviewKind {
	if (!location) return "none";
	const url = httpUrl(location);
	if (!url) return "none";
	const extension = pathExtension(url.pathname);
	if (extension && IMAGE_EXTENSIONS.has(extension)) return "image";
	return "none";
}

/**
 * PLOS SI permalink → classify as `image`. The card must still call Host
 * `webProxyResolveImage` and load the returned corpus URL; the permalink alone
 * cannot upgrade JPEG under today's allowlist-on-each-redirect proxy policy.
 */
function plosSupplementaryFileImage(url: URL): string | null {
	return isPlosSupplementaryFileUrl(url.href) ? url.href : null;
}

/**
 * After Host `webProxyResolveImage`, the card loads this URL through the proxy
 * (corpus host for JPEG SI), not the journals permalink. `null` → URL tip.
 *
 * Pure helper so tests can assert the corpus-host load path without a live
 * HEAD; the card wires the same decision after the IPC call.
 */
export function plosSupplementaryPreviewLoadUrl(
	permalink: string,
	hostResolved: { url: string } | null | undefined,
): string | null {
	if (!isPlosSupplementaryFileUrl(permalink)) return null;
	if (!hostResolved?.url) return null;
	const finalUrl = httpUrl(hostResolved.url);
	if (!finalUrl) return null;
	// Host already filtered; double-check the Location is inline-decodable so
	// a mistaken TIFF/PDF payload never reaches `<img>`.
	if (linkPreviewKindFromRedirectLocation(finalUrl.href) !== "image") {
		return null;
	}
	return finalUrl.href;
}

/** Publisher-specific permalink → direct image URL, when one is known. */
function publisherFigureImage(url: URL): string | null {
	return (
		elifeFigureImage(url) ??
		plosMainFigureImage(url) ??
		plosSupplementaryFileImage(url)
	);
}

/** Which hover card an external link should open, from its URL alone. */
export function classifyLinkPreview(raw: string): LinkPreviewKind {
	const url = httpUrl(raw);
	if (!url) return "none";
	// The `agentero-web` proxy always fetches https on the default port, so a
	// custom-port target would preview a different resource. Keep the URL tip.
	if (url.port) return "none";
	if (publisherFigureImage(url)) return "image";
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
 * permalinks resolve to the directly hosted figure image. PLOS SI file
 * permalinks stay as the journals permalink here (`kind: "image"`); the card
 * then Host-resolves to the corpus Location before the proxy `<img>` load.
 */
export function resolveLinkPreviewTarget(raw: string): LinkPreviewTarget {
	const url = httpUrl(raw);
	if (!url) return { kind: "none", url: raw.trim() };
	const image = publisherFigureImage(url);
	if (image) return { kind: "image", url: image };
	return { kind: classifyLinkPreview(raw), url: url.href };
}
