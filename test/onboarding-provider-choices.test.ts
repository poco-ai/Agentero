// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutStep } from "@/components/onboarding/steps/layout-step";
import { TranslateStep } from "@/components/onboarding/steps/translate-step";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import type { AppSettings } from "@/lib/settings/types";
import { COMMERCIAL_MT_DOCS_URLS } from "@/lib/translate/types";

const h = vi.hoisted(() => ({
	save: vi.fn(async (_settings: AppSettings) => {}),
	openUrl: vi.fn(),
	probeTranslation: vi.fn(async () => true),
	probeLayout: vi.fn(async () => true),
	patch: vi.fn(),
}));
vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => {} },
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/settings", () => ({ saveSettingsAsync: h.save }));
vi.mock("@/lib/core/open-external", () => ({ openExternalUrl: h.openUrl }));
vi.mock("@/lib/translate", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/translate")>()),
	probeCommercialMtProvider: h.probeTranslation,
}));
vi.mock("@/lib/pdf/layout/provider-config", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/pdf/layout/provider-config")
	>()),
	probeLayoutProvider: h.probeLayout,
}));

let root: Root;
let container: HTMLDivElement;
function button(key: string) {
	const found = [...document.body.querySelectorAll("button")].find((b) =>
		b.textContent?.includes(key),
	);
	expect(found, key).toBeDefined();
	return found as HTMLButtonElement;
}
async function click(key: string) {
	await act(async () => button(key).click());
}
async function render(
	step: "translate" | "layout",
	initial = structuredClone(DEFAULT_SETTINGS),
) {
	function Harness() {
		const [settings, setSettings] = useState(initial);
		return createElement(step === "translate" ? TranslateStep : LayoutStep, {
			settings,
			patch: (p: Partial<AppSettings>) => {
				h.patch(p);
				setSettings((prev) => ({ ...prev, ...p }));
			},
		});
	}
	await act(async () =>
		root.render(createElement(TooltipProvider, null, createElement(Harness))),
	);
}
async function setKey(value: string) {
	await act(async () => {
		const el = document.body.querySelector("input") as HTMLInputElement;
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	document.body.style.pointerEvents = "";
	vi.unstubAllGlobals();
});

describe("onboarding provider choices", () => {
	it.each([
		"translate",
		"layout",
	] as const)("shows the saved default first and keeps %s visible after selecting it", async (step) => {
		await render(step);
		const choices = [...container.querySelectorAll("button[aria-pressed]")];
		expect(choices).toHaveLength(2);
		expect(choices[0].textContent).toContain(`${step}.useDefault`);
		expect(choices[0].getAttribute("aria-pressed")).toBe("true");
		await click(`${step}.useDefault`);
		expect(button(`${step}.useDefault`).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(h.patch).toHaveBeenCalledTimes(1);
	});
	it.each([
		"translate",
		"layout",
	] as const)("opens %s configuration and its website without changing the saved choice", async (step) => {
		await render(step);
		await click(`${step}.configureOwn`);
		expect(document.querySelector("[role=dialog]")).not.toBeNull();
		expect(h.openUrl).toHaveBeenCalledTimes(1);
		expect(h.patch).not.toHaveBeenCalled();
		expect(h.save).not.toHaveBeenCalled();
		await click("close");
		expect(document.querySelector("[role=dialog]")).toBeNull();
		expect(button(`${step}.useDefault`).getAttribute("aria-pressed")).toBe(
			"true",
		);
	});
	it("saves the real translation key before masking it and selects the configured API", async () => {
		await render("translate");
		await click("translate.configureOwn");
		await setKey("test-translation-secret");
		await click("translate.test");
		const saved = h.save.mock.calls[0][0];
		expect(saved.translate.provider).toBe("deepl");
		expect(saved.translate.providerConfigs.deepl?.apiKey).toBe(
			"test-translation-secret",
		);
		expect(h.probeTranslation).toHaveBeenCalledWith("deepl", {
			config: expect.objectContaining({ apiKey: "test-translation-secret" }),
		});
		await click("close");
		expect(button("translate.configureOwn").getAttribute("aria-pressed")).toBe(
			"true",
		);
		await click("translate.configureOwn");
		expect(
			(document.querySelector("input") as HTMLInputElement).value,
		).not.toBe("test-translation-secret");
		expect(h.openUrl).toHaveBeenLastCalledWith(COMMERCIAL_MT_DOCS_URLS.deepl);
	});
	it("keeps body parsing independent when configuring or restoring layout recognition", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.layout.parserBackend = "mineru";
		await render("layout", settings);
		await click("layout.configureOwn");
		await setKey("test-layout-secret");
		await click("layout.test");
		expect(h.save.mock.calls[0][0].layout).toMatchObject({
			backend: "paddle",
			parserBackend: "mineru",
		});
		await click("close");
		expect(button("layout.configureOwn").getAttribute("aria-pressed")).toBe(
			"true",
		);
		await click("layout.useDefault");
		expect(h.patch).toHaveBeenLastCalledWith({
			layout: expect.objectContaining({
				backend: "local",
				parserBackend: "mineru",
			}),
		});
	});
	it("reflects an existing API on revisiting without replacing it when configuration is dismissed", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.translate.provider = "deepl";
		settings.translate.providerConfigs.deepl = {
			apiKey: "********",
			baseUrl: "",
			region: "",
			model: "",
		};
		await render("translate", settings);
		expect(button("translate.configureOwn").getAttribute("aria-pressed")).toBe(
			"true",
		);
		await click("translate.configureOwn");
		await click("close");
		expect(button("translate.configureOwn").getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(h.patch).not.toHaveBeenCalled();
	});
});
