// @vitest-environment happy-dom

import i18next from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorSettingsBlock } from "@/components/settings/panes/general/connector-settings-block";
import enCommon from "@/i18n/locales/en/common.json";
import enSettings from "@/i18n/locales/en/settings.json";
import zhCommon from "@/i18n/locales/zh-CN/common.json";
import zhSettings from "@/i18n/locales/zh-CN/settings.json";
import type { ConnectorStatus } from "@/lib/core/bindings";
import { connectorStatusError } from "@/lib/paper/import/connector-errors";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const api = vi.hoisted(() => ({
	connectorGetStatus: vi.fn(),
	connectorSetEnabled: vi.fn(),
	connectorSetPort: vi.fn(),
	notifyError: vi.fn(),
	patch: vi.fn(),
}));
vi.mock("@/lib/paper/import/connector", () => api);
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/notify", () => ({ notifyError: api.notifyError }));
vi.mock("@/components/settings/word-settings", () => ({
	WordSettings: () => null,
}));
let onStatus: (status: ConnectorStatus) => void;
vi.mock("@/hooks/use-tauri-event", () => ({
	useTauriEvent: (_event: unknown, handler: typeof onStatus) => {
		onStatus = handler;
	},
}));

const failed: ConnectorStatus = {
	enabled: true,
	listening: false,
	port: 23119,
	boundAddress: null,
	lastError: "Failed to bind 127.0.0.1:23119: Address already in use",
	lastErrorCode: "portInUse",
	vaultPath: null,
	parentDir: "papers",
};
const listening: ConnectorStatus = {
	...failed,
	listening: true,
	boundAddress: "127.0.0.1:23119",
	lastError: null,
	lastErrorCode: null,
};
const i18n = i18next.createInstance();
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	api.connectorGetStatus.mockResolvedValue(failed);
	api.connectorSetEnabled.mockResolvedValue(failed);
	await i18n.init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		interpolation: { escapeValue: false },
		resources: {
			en: { settings: enSettings, common: enCommon },
			"zh-CN": { settings: zhSettings, common: zhCommon },
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

async function render(enabled = true) {
	await act(async () =>
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(ConnectorSettingsBlock, {
					settings: { ...DEFAULT_SETTINGS, connectorEnabled: enabled },
					patch: api.patch,
				}),
			),
		),
	);
}

function retryButton() {
	return container.querySelector<HTMLButtonElement>(
		`button[aria-label="${i18n.t("common:tryAgain")}"]`,
	);
}

describe("Connector settings recovery (#959)", () => {
	it.each([
		"en",
		"zh-CN",
	])("shows an existing bind error and localizes manual-retry feedback in %s", async (locale) => {
		await i18n.changeLanguage(locale);
		await render();
		const message = connectorStatusError(
			failed,
			i18n.getFixedT(null, "settings"),
		);
		expect(container.textContent).toContain(message);
		expect(container.textContent).toContain("23119");
		expect(container.textContent).not.toContain(failed.lastError);
		expect(container.querySelector('[role="status"]')?.textContent).toBe(
			i18n.t("settings:general.connector.notListening"),
		);
		expect(container.querySelector(".bg-destructive")).not.toBeNull();
		expect(api.notifyError).not.toHaveBeenCalled();
		await act(async () => retryButton()?.click());
		expect(api.connectorSetEnabled).toHaveBeenCalledWith(true);
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.notifyError).toHaveBeenCalledWith(message);
	});

	it("clears the error and retry action when recovery arrives from the Host", async () => {
		await render();
		await act(async () => onStatus(listening));
		expect(retryButton()).toBeNull();
		expect(container.textContent).toContain(enCommon.listening);
		expect(container.textContent).not.toContain(
			enSettings.general.connector.notListening,
		);
		expect(container.querySelector(".bg-destructive")).toBeNull();
		expect(api.notifyError).not.toHaveBeenCalled();
	});

	it("hides a stale failure once compatibility is disabled", async () => {
		await render(false);
		expect(retryButton()).toBeNull();
		expect(container.textContent).not.toContain(
			enSettings.general.connector.notListening,
		);
	});

	it("localizes non-conflict lifecycle failures and clears successful status", async () => {
		await i18n.changeLanguage("zh-CN");
		const t = i18n.getFixedT(null, "settings");
		for (const [code, key] of [
			["bindFailed", "bindFailed"],
			["serverStopped", "serverStopped"],
			["invalidPort", "invalidPort"],
		] as const) {
			expect(connectorStatusError({ ...failed, lastErrorCode: code }, t)).toBe(
				t(`general.connector.${key}`, { port: 23119 }),
			);
		}
		expect(connectorStatusError(listening, t)).toBeNull();
	});
});
