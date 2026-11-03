// @vitest-environment happy-dom

import i18next from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HtmlViewer } from "@/components/viewer/html-viewer";
import zhViewer from "@/i18n/locales/zh-CN/viewer.json";
import { clearArxivHtmlCache } from "@/lib/paper/arxiv-html";

vi.mock("@/components/viewer/web-view/use-web-view-selection", () => ({
	useWebViewSelection: () => ({
		onFrameLoad: () => undefined,
		menu: null,
		ask: null,
		copiedLabelPos: null,
		translateRec: null,
		translateScreen: null,
		streaming: false,
		askError: null,
		translateStreaming: false,
		translateError: null,
		handleAsk: () => undefined,
		handleAddToChat: () => undefined,
		handleTranslate: () => undefined,
		sendAskQuestion: () => undefined,
		resendAskQuestion: () => undefined,
		hideAsk: () => undefined,
		deleteAsk: () => undefined,
		stopAskStreaming: () => undefined,
		openTranslateSettings: () => undefined,
		hideTranslate: () => undefined,
	}),
}));

const PAGE = "https://arxiv.org/html/1706.03762";
const DOCUMENT =
	"<!DOCTYPE html><html><head></head><body><p>Attention</p></body></html>";
const i18n = i18next.createInstance();
let container: HTMLDivElement;
let root: Root;
const showPdf = vi.fn();

function response(status: number, body: string): Promise<Response> {
	return Promise.resolve(
		new Response(body, { status, headers: { "content-type": "text/html" } }),
	);
}

async function show(srcUrl: string) {
	await act(async () => {
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(HtmlViewer, {
					srcUrl,
					onShowPdf: showPdf,
				}),
			),
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	clearArxivHtmlCache();
	showPdf.mockClear();
	if (!i18n.isInitialized) {
		await i18n.init({
			lng: "zh-CN",
			fallbackLng: "zh-CN",
			ns: ["viewer"],
			defaultNS: "viewer",
			interpolation: { escapeValue: false },
			resources: { "zh-CN": { viewer: zhViewer } },
		});
	}
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	clearArxivHtmlCache();
});

it("embeds a paper that has HTML instead of the proxy error", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => response(200, DOCUMENT)),
	);
	await show(PAGE);
	const frame = container.querySelector("iframe");
	expect(
		container
			.querySelector("[data-arxiv-html]")
			?.getAttribute("data-arxiv-html"),
	).toBe("ready");
	expect(frame?.getAttribute("srcdoc")).toContain("Attention");
	expect(frame?.getAttribute("srcdoc")).toContain(`<base href="${PAGE}">`);
	expect(container.textContent).not.toContain("arXiv unavailable");
	expect(frame?.getAttribute("src")).toBeNull();
});

it("says when a paper has no HTML and can return to the PDF", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => response(404, "missing")),
	);
	await show("https://arxiv.org/abs/0000.00000");
	expect(container.textContent).toContain("这篇论文还没有 HTML 版本");
	expect(container.textContent).not.toContain("arXiv unavailable");
	const back = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("返回 PDF"),
	);
	back?.click();
	expect(showPdf).toHaveBeenCalledTimes(1);
	expect(container.textContent).toContain("打开摘要");
});

it("says when the network cannot open HTML", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
	);
	await show(PAGE);
	expect(container.textContent).toContain("网络不可用");
	expect(container.textContent).not.toContain("arXiv unavailable");
});

it("says when the arXiv address is not a paper", async () => {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	await show("https://arxiv.org/html/not-a-paper");
	expect(container.textContent).toContain("HTML 地址无效");
	expect(fetchMock).not.toHaveBeenCalled();
});
