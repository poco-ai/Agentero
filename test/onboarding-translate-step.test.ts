// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslateStep } from "@/components/onboarding/steps/translate-step";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { COMMERCIAL_MT_PROVIDER_IDS } from "@/lib/translate";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function renderStep(settings: AppSettings) {
	const patch = vi.fn();
	act(() => {
		root.render(
			createElement(
				TooltipProvider,
				null,
				createElement(TranslateStep, {
					settings,
					patch,
					onUseDefault: () => undefined,
					onNextChange: () => undefined,
				}),
			),
		);
	});
	return patch;
}

function clickConfigureOwn() {
	const card = [...container.querySelectorAll("button")].find((b) =>
		b.textContent?.includes("translate.configureOwn"),
	);
	expect(card).toBeDefined();
	act(() => card?.click());
}

describe("onboarding translate step", () => {
	it("preselects AI/ML API when the user brings their own key", () => {
		const patch = renderStep(DEFAULT_SETTINGS);
		clickConfigureOwn();
		expect(patch).toHaveBeenCalledWith({
			translate: { ...DEFAULT_SETTINGS.translate, provider: "aimlapi" },
		});
		expect(COMMERCIAL_MT_PROVIDER_IDS[0]).toBe("aimlapi");
	});

	it("keeps a commercial provider the user already chose", () => {
		const patch = renderStep({
			...DEFAULT_SETTINGS,
			translate: { ...DEFAULT_SETTINGS.translate, provider: "deepl" },
		});
		clickConfigureOwn();
		expect(patch).not.toHaveBeenCalled();
	});
});
