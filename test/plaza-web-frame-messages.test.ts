// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init() {} },
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/tooltip", () => {
	const Pass = ({ children }: { children: ReactNode }) => children;
	return { Tooltip: Pass, TooltipContent: () => null, TooltipTrigger: Pass };
});
vi.mock("@/hooks/use-iframe-drag-shield", () => ({
	useIframeDragShield: () => false,
}));
vi.mock("@/lib/core/open-external", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/lib/plaza/import", () => ({
	importPlazaPaper: vi.fn(async () => true),
}));
vi.mock("@/lib/plaza/imported", () => ({
	importedIdsInLibrary: vi.fn(async () => []),
}));

let container: HTMLDivElement;
let root: Root;
const origin = "https://proxy.example";
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	const contentWindow = Object.getOwnPropertyDescriptor(
		HTMLIFrameElement.prototype,
		"contentWindow",
	)?.get;
	vi.spyOn(
		HTMLIFrameElement.prototype,
		"contentWindow",
		"get",
	).mockImplementation(function () {
		const frame = contentWindow?.call(this) as Window | null;
		if (frame && !vi.isMockFunction(frame.postMessage))
			vi.spyOn(frame, "postMessage").mockImplementation(() => {});
		return frame;
	});
	// Give each real iframe a local document/window without fetching a remote site.
	const createElement = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
		const element = createElement(tagName, options);
		if (tagName === "iframe")
			element.setAttribute("srcdoc", "<html><body></body></html>");
		return element;
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	localStorage.clear();
	vi.unstubAllGlobals();
});
async function mountFrames() {
	await act(async () => {
		root.render(
			createElement(
				"div",
				null,
				...["first", "second"].map((title) =>
					createElement(PlazaWebFrame, {
						key: title,
						homeUrl: "https://site.example/",
						embedOrigin: origin,
						lastPathStorageKey: title,
						title,
					}),
				),
			),
		);
	});
	return [...container.querySelectorAll("iframe")];
}
async function navigate(
	source: Window | null,
	path: string,
	messageOrigin = origin,
) {
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: messageOrigin,
				source,
				data: { source: "agentero-plaza", path },
			}),
		);
	});
}

describe("retained Plaza frame messages", () => {
	it("handles navigation only for the sending frame without replacing either iframe", async () => {
		const [first, second] = await mountFrames();
		await navigate(first.contentWindow, "/paper/one");
		expect(localStorage.getItem("first")).toBe("/paper/one");
		expect(localStorage.getItem("second")).toBe("/");
		await navigate(second.contentWindow, "/paper/two");
		expect(localStorage.getItem("first")).toBe("/paper/one");
		expect(localStorage.getItem("second")).toBe("/paper/two");
		expect([...container.querySelectorAll("iframe")]).toEqual([first, second]);
		expect(first.getAttribute("src")).toBe(`${origin}/`);
	});

	it("ignores messages from other windows, missing senders and wrong origins", async () => {
		const [first] = await mountFrames();
		await navigate(window, "/foreign");
		await navigate(null, "/missing");
		await navigate(
			first.contentWindow,
			"/wrong-origin",
			"https://other.example",
		);
		expect(localStorage.getItem("first")).toBe("/");
		expect(localStorage.getItem("second")).toBe("/");
	});

	it("removes listeners when the tabs close", async () => {
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");
		const [first] = await mountFrames();
		const listeners = add.mock.calls
			.filter(([type]) => type === "message")
			.map(([, listener]) => listener);
		expect(listeners).toHaveLength(4);
		const sender = first.contentWindow;
		await act(() => root.render(null));
		for (const listener of listeners) {
			expect(remove).toHaveBeenCalledWith("message", listener);
		}
		await navigate(sender, "/after-close");
		expect(localStorage.getItem("first")).toBe("/");
	});
});
