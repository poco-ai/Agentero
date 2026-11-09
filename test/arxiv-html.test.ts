import { afterEach, expect, it, vi } from "vitest";
import {
	ARXIV_HTML_ATTEMPT_MS,
	classifyArxivHtmlResponse,
	clearArxivHtmlCache,
	loadArxivHtml,
	resolveArxivHtmlPage,
	rewriteArxivHtml,
} from "@/lib/paper/arxiv-html";

const PAGE = "https://arxiv.org/html/1706.03762";
const DOCUMENT =
	'<!DOCTYPE html><html><head></head><body><img src="1706.03762v7/Figures/a.png"></body></html>';

afterEach(() => {
	clearArxivHtmlCache();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function jsonResponse(
	status: number,
	body: string,
	url = PAGE,
): Promise<Response> {
	return Promise.resolve(
		new Response(body, { status, headers: { "content-type": "text/html" } }),
	).then((response) => {
		Object.defineProperty(response, "url", { value: url });
		return response;
	});
}

it("canonicalizes an abstract or versioned url to the html page", () => {
	expect(resolveArxivHtmlPage("https://arxiv.org/abs/1706.03762v2")).toEqual({
		pageUrl: PAGE,
		absUrl: "https://arxiv.org/abs/1706.03762",
	});
	expect(resolveArxivHtmlPage("https://arxiv.org/pdf/1706.03762.pdf")).toEqual({
		pageUrl: PAGE,
		absUrl: "https://arxiv.org/abs/1706.03762",
	});
	expect(resolveArxivHtmlPage("https://arxiv.org/html/not-a-paper")).toBeNull();
	expect(
		resolveArxivHtmlPage("https://example.com/html/1706.03762"),
	).toBeNull();
});

it("keeps assets on arxiv and leaves in-page anchors alone", () => {
	const html = rewriteArxivHtml(
		'<!DOCTYPE html><html><head></head><body><a href="#S1">Intro</a><img src="1706.03762v7/Figures/a.png"><link href="/static/browse/paper.css"></body></html>',
		PAGE,
	);
	expect(html).toContain(`<base href="${PAGE}">`);
	expect(html).toContain('href="#S1"');
	expect(html).toContain('src="1706.03762v7/Figures/a.png"');
	expect(html).toContain('href="/static/browse/paper.css"');
	expect(html).not.toContain("agentero-arxiv");
});

it("treats 404 as missing and a real document as ready", () => {
	expect(classifyArxivHtmlResponse(404, PAGE, "missing")).toBe("missing");
	expect(
		classifyArxivHtmlResponse(
			200,
			"https://arxiv.org/abs/1706.03762",
			DOCUMENT,
		),
	).toBe("missing");
	expect(classifyArxivHtmlResponse(200, PAGE, DOCUMENT)).toBe("ready");
	expect(classifyArxivHtmlResponse(503, PAGE, DOCUMENT)).toBe("network");
});

it("loads a paper that has HTML and reuses it", async () => {
	const fetchMock = vi.fn(() => jsonResponse(200, DOCUMENT));
	vi.stubGlobal("fetch", fetchMock);
	const first = await loadArxivHtml(PAGE);
	expect(first.status).toBe("ready");
	if (first.status === "ready")
		expect(first.html).toContain(`<base href="${PAGE}">`);
	const second = await loadArxivHtml(PAGE);
	expect(second.status).toBe("ready");
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("reports a paper with no HTML without retrying", async () => {
	const fetchMock = vi.fn(() => jsonResponse(404, "no html"));
	vi.stubGlobal("fetch", fetchMock);
	await expect(loadArxivHtml(PAGE)).resolves.toEqual({ status: "missing" });
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retries a network error once, then reports the network", async () => {
	const fetchMock = vi
		.fn()
		.mockRejectedValueOnce(new TypeError("Failed to fetch"))
		.mockRejectedValueOnce(new TypeError("Failed to fetch"));
	vi.stubGlobal("fetch", fetchMock);
	await expect(loadArxivHtml(PAGE)).resolves.toEqual({ status: "network" });
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("retries a stalled download on a new connection", async () => {
	vi.useFakeTimers();
	const fetchMock = vi.fn(
		(_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted", "AbortError"));
				});
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const pending = loadArxivHtml(PAGE);
	await vi.advanceTimersByTimeAsync(ARXIV_HTML_ATTEMPT_MS);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(ARXIV_HTML_ATTEMPT_MS);
	await expect(pending).resolves.toEqual({ status: "network" });
});

it("injects the shared selection bridge so Escape and shortcuts reach the app", () => {
	const out = rewriteArxivHtml(DOCUMENT, PAGE);
	expect(out).toContain('type: "escape"');
	expect(out).toContain('message.source = "agentero-web"');
});
