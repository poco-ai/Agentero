// @vitest-environment happy-dom
import type { PdfEngine } from "@embedpdf/models";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfToolbar } from "@/components/viewer/pdf/chrome/pdf-toolbar";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init() {} },
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-shortcut-label", () => ({ useShortcutLabel: () => "" }));
vi.mock("@/hooks/use-app-stores", () => ({ useSettings: () => "vertical" }));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({}),
	saveSettings: vi.fn(),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it.each([
	true,
	false,
])("uses the original translation icon to switch languages with translations visible=%s", async (visible) => {
	const toggle = vi.fn();
	const props = {
		regionSelecting: false,
		visualCropPending: false,
		engine: {} as PdfEngine,
		onToggleRegionSelect: vi.fn(),
		layoutTranslateRunning: false,
		layoutTranslateActive: visible,
		layoutTranslateLabel: visible ? "Show original" : "Show translation",
		onToggleLayoutTranslate: toggle,
	};
	await act(() => root.render(createElement(PdfToolbar, props)));
	const original = host.querySelector<HTMLButtonElement>(
		"[data-full-text-translate] button",
	);
	expect(original).not.toBeNull();
	expect(original?.getAttribute("aria-label")).toBe(props.layoutTranslateLabel);
	expect(original?.textContent).toBe("");
	expect(host.querySelectorAll("button[aria-label^='Show ']")).toHaveLength(1);
	expect(original?.closest("[inert]")).toBeNull();
	await act(() => {
		original?.click();
	});
	expect(toggle).toHaveBeenCalledOnce();
	expect(host.querySelector('button[aria-label*="Clear"]')).toBeNull();
});
