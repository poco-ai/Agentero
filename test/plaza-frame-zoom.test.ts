// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";

vi.mock("@/components/viewer/web-view/use-web-view-selection", () => ({
	useWebViewSelection: () => ({ onFrameLoad: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/tooltip", () => {
	const Pass = ({ children }: { children: ReactNode }) => children;
	return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: () => null };
});
vi.mock("@/hooks/use-iframe-drag-shield", () => ({
	useIframeDragShield: () => false,
}));
vi.mock("@/lib/core/open-external", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/lib/plaza/import", () => ({ importPlazaPaper: vi.fn() }));
vi.mock("@/lib/plaza/imported", () => ({ importedIdsInLibrary: vi.fn() }));

let resize: (entries: unknown[]) => void;
const disconnect = vi.fn();
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const create = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
		const element = create(tag, options);
		if (tag === "iframe")
			element.setAttribute("srcdoc", "<html><body></body></html>");
		return element;
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: typeof resize) {
				resize = callback;
			}
			observe() {}
			disconnect = disconnect;
		},
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	expect(disconnect).toHaveBeenCalled();
	host.remove();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function mount(desktopWidth?: number, embedOrigin: string | null = null) {
	await act(() =>
		root.render(
			createElement(PlazaWebFrame, {
				homeUrl: "https://site.example/",
				embedOrigin,
				title: "fixture",
				desktopWidth,
			}),
		),
	);
	const frame = host.querySelector("iframe");
	if (!frame) throw new Error("Missing iframe");
	return frame;
}
async function size(width: number, height = 600) {
	await act(() => resize([{ contentRect: { width, height } }]));
}
async function click(key: string) {
	const button = host.querySelector<HTMLButtonElement>(
		`[aria-label="plaza.${key}"]`,
	);
	if (!button) throw new Error(`Missing ${key}`);
	await act(() => button.click());
}
async function message(
	frame: HTMLIFrameElement,
	origin: string,
	data: Record<string, unknown>,
	source: Window | null = frame.contentWindow,
) {
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				origin,
				source,
				data: { source: "agentero-plaza", ...data },
			}),
		);
	});
}
describe("Plaza frame zoom", () => {
	it("fits a fixed desktop page as sidebars resize, preserving iframe and document state", async () => {
		const frame = await mount(1280);
		await size(1280);
		const doc = frame.contentDocument;
		if (!doc) throw new Error("Missing frame document");
		doc.body.innerHTML = '<input value="keep me">';
		await size(640);
		expect(frame.style.width).toBe("1280px");
		expect(frame.style.height).toBe("1200px");
		expect(frame.style.transform).toBe("scale(0.5)");
		await size(320);
		expect(frame.style.transform).toBe("scale(0.25)");
		await size(0, 0);
		expect(frame.style.transform).toBe("scale(0.25)");
		await size(1440);
		expect(frame.style.transform).toBe("scale(1)");
		expect(frame.style.width).toBe("1440px");
		expect(host.querySelector("iframe")).toBe(frame);
		expect(frame.contentDocument).toBe(doc);
		expect(doc.querySelector("input")?.value).toBe("keep me");
	});
	it("hands wheel overflow the frame cannot consume to the outer scrollport", async () => {
		const origin = "https://proxy.example";
		const frame = await mount(1280, origin);
		await size(640);
		const viewport = frame.parentElement?.parentElement;
		if (!(viewport instanceof HTMLDivElement)) {
			throw new Error("Missing viewport");
		}
		expect(viewport.className).toContain("overflow-auto");

		await message(frame, origin, { panX: 140 });
		expect(viewport.scrollLeft).toBe(140);

		// Only the frame itself may pan the host viewport.
		await message(frame, origin, { panX: 999 }, window);
		expect(viewport.scrollLeft).toBe(140);
	});
	it("zooms from the wheel and pinch ratio messages", async () => {
		const origin = "https://proxy.example";
		const frame = await mount(1280, origin);
		await size(640);
		expect(frame.style.transform).toBe("scale(0.5)");

		// A motionless gesture must not leave automatic fit.
		await message(frame, origin, { zoomRatio: 1 });
		expect(
			host
				.querySelector('[aria-label="plaza.fitWidth"]')
				?.getAttribute("aria-pressed"),
		).toBe("true");

		await message(frame, origin, { zoomRatio: 2 });
		expect(frame.style.transform).toBe("scale(1)");
		expect(
			host
				.querySelector('[aria-label="plaza.fitWidth"]')
				?.getAttribute("aria-pressed"),
		).toBe("false");

		await message(frame, origin, { zoomRatio: 0.1 });
		expect(frame.style.transform).toBe("scale(0.25)");

		// A non-positive ratio is not a zoom request.
		await message(frame, origin, { zoomRatio: 0 });
		expect(frame.style.transform).toBe("scale(0.25)");
	});
	it("keeps manual zoom on resize, exposes overflow, and restores automatic fit", async () => {
		const frame = await mount(1280);
		await size(640);
		await click("zoomIn");
		expect(frame.style.transform).toBe("scale(0.67)");
		expect(
			Number.parseFloat(frame.parentElement?.style.width ?? "0"),
		).toBeCloseTo(857.6);
		await size(800);
		expect(frame.style.transform).toBe("scale(0.67)");
		expect(
			host
				.querySelector('[aria-label="plaza.fitWidth"]')
				?.getAttribute("aria-pressed"),
		).toBe("false");
		await click("fitWidth");
		expect(frame.style.transform).toBe("scale(0.625)");
		expect(
			host
				.querySelector('[aria-label="plaza.fitWidth"]')
				?.getAttribute("aria-pressed"),
		).toBe("true");
		expect(host.querySelector("iframe")).toBe(frame);
	});
	it("lets responsive sources reflow and bounds manual zoom", async () => {
		const frame = await mount();
		await size(640);
		expect(frame.style.width).toBe("640px");
		await size(320);
		expect(frame.style.width).toBe("320px");
		for (let i = 0; i < 15; i++) await click("zoomOut");
		expect(frame.style.transform).toBe("scale(0.25)");
		expect(
			host.querySelector<HTMLButtonElement>('[aria-label="plaza.zoomOut"]')
				?.disabled,
		).toBe(true);
		for (let i = 0; i < 15; i++) await click("zoomIn");
		expect(frame.style.transform).toBe("scale(2)");
		expect(
			host.querySelector<HTMLButtonElement>('[aria-label="plaza.zoomIn"]')
				?.disabled,
		).toBe(true);
		await click("fitWidth");
		expect(frame.style.transform).toBe("scale(1)");
	});
});
