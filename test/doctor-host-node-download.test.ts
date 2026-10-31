// @vitest-environment happy-dom

import i18next from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoctorHostRuntimeSection } from "@/components/settings/panes/doctor-host-runtime-section";
import { TooltipProvider } from "@/components/ui/tooltip";
import enSettings from "@/i18n/locales/en/settings.json";
import zhSettings from "@/i18n/locales/zh-CN/settings.json";
import type { HostDoctorReport } from "@/lib/doctor/api";
import { NODE_DOWNLOAD_URL } from "@/lib/doctor/node-guidance";

const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/core/open-external", () => ({ openExternalUrl }));
vi.mock("@/lib/doctor/install-node", () => ({
	installNodeInBackground: vi.fn(),
}));

const i18n = i18next.createInstance();
let container: HTMLDivElement;
let root: Root;

const missing: HostDoctorReport = {
	node: { status: "missing" },
	npm: { status: "missing" },
};

async function render(report: HostDoctorReport) {
	await act(async () =>
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(
					TooltipProvider,
					null,
					createElement(DoctorHostRuntimeSection, {
						report,
						onRefresh: async () => {},
					}),
				),
			),
		),
	);
}

function downloadButton() {
	return [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes(enSettings.doctor.host.install.download),
	);
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	openExternalUrl.mockClear();
	await i18n.init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		interpolation: { escapeValue: false },
		resources: {
			en: { settings: enSettings },
			"zh-CN": { settings: zhSettings },
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("Doctor Host runtime: Node.js download fallback (#859)", () => {
	it("offers nodejs.org whenever Node.js is missing, with no package manager needed", async () => {
		await render(missing);
		const button = downloadButton();
		expect(button).toBeDefined();
		await act(async () => button?.click());
		expect(openExternalUrl).toHaveBeenCalledWith(NODE_DOWNLOAD_URL);
	});

	it("hides the fallback once Node.js and npm are available", async () => {
		await render({
			node: { status: "available", version: "v22.0.0" },
			npm: { status: "available", version: "10.0.0" },
		});
		expect(downloadButton()).toBeUndefined();
	});

	it("labels the fallback in both locales", () => {
		expect(zhSettings.doctor.host.install.download).toBeTruthy();
		expect(enSettings.doctor.host.install.download).toBeTruthy();
	});
});
