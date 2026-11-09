/**
 * Load an arXiv HTML paper in the webview.
 *
 * arXiv answers `Access-Control-Allow-Origin: *` and `404` when no HTML has
 * been generated. Fetching here keeps CSS, scripts, and figures on arXiv's
 * own hosts (resolved by `<base>`), instead of pulling every one through the
 * `agentero-arxiv` proxy. That proxy turned a dropped connection, a timeout,
 * and a missing paper into the same "arXiv unavailable" body, and it held the
 * document until the whole download finished.
 */

import {
	arxivUrls,
	isArxivHostedUrl,
	normalizeArxivId,
} from "@/lib/paper/arxiv";
import selectionBridge from "@/lib/web-view/selection-bridge.js?raw";

/**
 * One attempt. A full HTML page on a slow link can take around 45s, so this
 * stays long enough for a download that is still moving. A stalled attempt is
 * aborted and tried once more.
 */
export const ARXIV_HTML_ATTEMPT_MS = 60_000;

const CACHE_LIMIT = 8;

const READER_STYLE =
	"<style>.desktop_header,nav.ltx_TOC,.btn.btn-primary.hover-rp-button,#footer,.ltx_page_footer{display:none !important}</style>";

const EXTERNAL_LINK_SCRIPT =
	'<script>document.addEventListener("click",function(event){var node=event.target;if(!node||!node.closest)return;var link=node.closest("a");if(!link)return;var href=link.getAttribute("href")||"";if(!href||href.charAt(0)==="#")return;link.setAttribute("target","_blank");link.setAttribute("rel","noopener noreferrer")},true);</script>';

export type ArxivHtmlPage = {
	pageUrl: string;
	absUrl: string;
};

export type ArxivHtmlLoad =
	| { status: "ready"; html: string }
	| { status: "missing" | "network" | "aborted" };

const cache = new Map<string, string>();

/** Canonical HTML and abstract URLs, or null when `url` is not an arXiv paper. */
export function resolveArxivHtmlPage(url: string): ArxivHtmlPage | null {
	if (!isArxivHostedUrl(url)) return null;
	const id = normalizeArxivId(url);
	if (!id) return null;
	const urls = arxivUrls(id);
	if (!urls) return null;
	return { pageUrl: urls.html, absUrl: urls.abs };
}

export function peekArxivHtml(pageUrl: string): string | null {
	return cache.get(pageUrl) ?? null;
}

export function clearArxivHtmlCache(): void {
	cache.clear();
}

function remember(pageUrl: string, html: string): void {
	if (cache.has(pageUrl)) cache.delete(pageUrl);
	cache.set(pageUrl, html);
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;");
}

/** Point root-absolute and relative assets at arXiv, and keep in-page anchors. */
export function rewriteArxivHtml(html: string, pageUrl: string): string {
	const head = `<base href="${escapeAttr(pageUrl)}">${READER_STYLE}${EXTERNAL_LINK_SCRIPT}<script>${selectionBridge}</script>`;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (open) => `${open}${head}`);
	}
	return `${head}${html}`;
}

function looksLikeDocument(body: string): boolean {
	const head = body
		.trim()
		.slice(0, 64)
		.replace(/^\uFEFF/, "")
		.trimStart()
		.slice(0, 16)
		.toLowerCase();
	return head.startsWith("<!doctype") || head.startsWith("<html");
}

function isArxivHtmlLocation(url: string): boolean {
	try {
		const parsed = new URL(url);
		return isArxivHostedUrl(url) && parsed.pathname.startsWith("/html/");
	} catch {
		return false;
	}
}

/** Map one completed response to a reader status. Exported for tests. */
export function classifyArxivHtmlResponse(
	status: number,
	finalUrl: string,
	body: string,
): "ready" | "missing" | "network" {
	if (status === 404 || status === 410) return "missing";
	if (status === 408 || status === 429 || status >= 500) return "network";
	if (status < 200 || status >= 300) return "network";
	if (!isArxivHtmlLocation(finalUrl)) return "missing";
	if (!looksLikeDocument(body)) return "missing";
	return "ready";
}

function attemptSignal(
	parent: AbortSignal | undefined,
	onTimeout: () => void,
): { signal: AbortSignal; done: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		onTimeout();
		controller.abort();
	}, ARXIV_HTML_ATTEMPT_MS);
	const abortFromParent = () => controller.abort();
	parent?.addEventListener("abort", abortFromParent);
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

async function fetchOnce(
	pageUrl: string,
	parent: AbortSignal | undefined,
): Promise<ArxivHtmlLoad | "timeout"> {
	let timedOut = false;
	const attempt = attemptSignal(parent, () => {
		timedOut = true;
	});
	try {
		const response = await fetch(pageUrl, {
			signal: attempt.signal,
			redirect: "follow",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			headers: { Accept: "text/html,application/xhtml+xml" },
		});
		if (response.status === 404 || response.status === 410) {
			return { status: "missing" };
		}
		const body = await response.text();
		const status = classifyArxivHtmlResponse(
			response.status,
			response.url || pageUrl,
			body,
		);
		if (status === "ready") {
			const html = rewriteArxivHtml(body, pageUrl);
			remember(pageUrl, html);
			return { status: "ready", html };
		}
		return { status };
	} catch {
		if (parent?.aborted) return { status: "aborted" };
		if (timedOut) return "timeout";
		return { status: "network" };
	} finally {
		attempt.done();
	}
}

/**
 * Fetch the HTML paper. A transport failure or a stalled attempt is retried
 * once; 404 is not. A second open of the same paper returns the rewritten
 * page without another request.
 */
export async function loadArxivHtml(
	pageUrl: string,
	parent?: AbortSignal,
): Promise<ArxivHtmlLoad> {
	const cached = cache.get(pageUrl);
	if (cached) return { status: "ready", html: cached };
	let sawTimeout = false;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (parent?.aborted) return { status: "aborted" };
		const result = await fetchOnce(pageUrl, parent);
		if (result === "timeout") {
			sawTimeout = true;
			continue;
		}
		if (result.status === "network" && attempt === 0) continue;
		if (result.status === "network" && sawTimeout) return { status: "network" };
		return result;
	}
	return { status: "network" };
}
