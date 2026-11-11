// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfReadingPopover } from "@/components/viewer/pdf/chrome/pdf-reading-popover";
import { DEFAULT_READING_SETTINGS } from "@/lib/pdf/reading/settings";

const { settings, save } = vi.hoisted(() => ({
	settings: { pdfScrollStrategy: "vertical", pdfSpreadMode: "none" },
	save: vi.fn(),
}));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-app-stores", () => ({
	useSettings: (selector: (s: typeof settings) => unknown) =>
		selector(settings),
}));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => settings,
	saveSettings: save,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it("shows PDF scroll/spread controls or reader typography while keeping split and themes in both modes", async () => {
	const props = {
		enabled: false,
		onEnabledChange: vi.fn(),
		settings: DEFAULT_READING_SETTINGS,
		onSettingsChange: vi.fn(),
		available: true,
		pdfSplit: "single" as const,
		onPdfSplitChange: vi.fn(),
	};
	await act(() => root.render(createElement(PdfReadingPopover, props)));
	await act(() => host.querySelector<HTMLButtonElement>("button")?.click());
	const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');
	expect(panel()?.querySelectorAll('[role="slider"]')).toHaveLength(0);
	expect(
		panel()?.querySelector(
			'button[aria-label="pdf.reading.scroll.horizontal"]',
		),
	).not.toBeNull();
	const grid = panel()?.querySelector<HTMLButtonElement>(
		'button[aria-label="pdf.reading.scroll.grid"]',
	);
	expect(grid).toBeNull();
	expect(
		panel()?.querySelector('button[aria-label="pdf.reading.spread.even"]'),
	).not.toBeNull();
	await act(() =>
		panel()
			?.querySelector<HTMLButtonElement>(
				'button[aria-label="pdf.reading.scroll.horizontal"]',
			)
			?.click(),
	);
	expect(save).toHaveBeenCalledWith({
		...settings,
		pdfScrollStrategy: "horizontal",
	});
	expect(
		panel()?.querySelector(
			'button[aria-label="pdf.reading.pdfLayout.side-by-side"]',
		),
	).not.toBeNull();
	expect(
		panel()?.querySelector('button[aria-label="pdf.reading.themes.sepia"]'),
	).not.toBeNull();
	await act(() =>
		panel()
			?.querySelector<HTMLButtonElement>(
				'button[aria-label="pdf.reading.pdfLayout.side-by-side"]',
			)
			?.click(),
	);
	expect(props.onPdfSplitChange).toHaveBeenCalledWith("side-by-side");
	expect(props.onSettingsChange).not.toHaveBeenCalled();
	expect(props.onEnabledChange).not.toHaveBeenCalled();
	await act(() =>
		root.render(createElement(PdfReadingPopover, { ...props, enabled: true })),
	);
	expect(panel()?.querySelectorAll('[role="slider"]')).toHaveLength(4);
	expect(
		panel()?.querySelector(
			'button[aria-label="pdf.reading.scroll.horizontal"]',
		),
	).toBeNull();
	expect(
		panel()?.querySelector('button[aria-label="pdf.reading.spread.even"]'),
	).toBeNull();
	expect(
		panel()?.querySelector(
			'button[aria-label="pdf.reading.layout.side-by-side"]',
		),
	).not.toBeNull();
	expect(
		panel()?.querySelector('button[aria-label="pdf.reading.themes.sepia"]'),
	).not.toBeNull();
	await act(() =>
		panel()
			?.querySelector<HTMLButtonElement>(
				'button[aria-label="pdf.reading.layout.top-bottom"]',
			)
			?.click(),
	);
	expect(props.onSettingsChange).toHaveBeenCalledWith({ split: "top-bottom" });
	expect(props.onPdfSplitChange).toHaveBeenCalledTimes(1);
});
