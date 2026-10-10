import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import type { AppSettings } from "@/lib/settings/types";

/**
 * Behavioral regression for the settings window (?window=settings branch of
 * the real `main.tsx`): the boot must hydrate the shared settings store from
 * the Host before anything in that window can persist a patch. Guards the
 * quick-setup regression where a patch sent the module-default snapshot and
 * wiped the Host settings file. Only the Tauri IPC boundary and React
 * rendering are mocked; `lib/settings` + `react-store` are the real modules.
 */

const h = vi.hoisted(() => ({
	/** Host-side settings.json content served over settings_get. */
	host: null as AppSettings | null,
	/** Full snapshots received by settings_set. */
	setCalls: [] as AppSettings[],
	/** (event name, callback) pairs registered through the event API. */
	listeners: [] as Array<{ name: string; cb: (e: unknown) => void }>,
	/** createRoot(...).render(...) invocations (boot reached the render). */
	renders: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {},
	invoke: (cmd: string, args?: { settings?: AppSettings }) => {
		if (cmd === "settings_set") {
			h.setCalls.push(args?.settings as AppSettings);
			return Promise.resolve({ ok: true, data: args?.settings });
		}
		// settings_get: the Host file exists with the fixture content.
		return Promise.resolve({
			ok: true,
			data: {
				settings: h.host,
				path: "/tmp/settings.json",
				existed: true,
			},
		});
	},
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (name: string, cb: (e: unknown) => void) => {
		h.listeners.push({ name, cb });
		return Promise.resolve(() => {});
	},
	once: () => Promise.resolve(() => {}),
	emit: () => Promise.resolve(),
}));

const createRootMock = () => ({
	render: (...args: unknown[]) => h.renders.push(args),
});
vi.mock("react-dom/client", () => ({
	createRoot: createRootMock,
	default: { createRoot: createRootMock },
}));

// Node test env has no webview globals; main.tsx reads location/window at
// module scope and touches document during boot.
vi.stubGlobal("location", { search: "?window=settings" });
vi.stubGlobal("window", globalThis);
vi.stubGlobal("addEventListener", () => {});
// Real `isTauri()` must take the Tauri branch so the store talks to the mock IPC.
vi.stubGlobal("__TAURI_INTERNALS__", {});
vi.stubGlobal("document", {
	getElementById: () => fakeElement(),
	documentElement: fakeElement(),
	head: { appendChild: () => {} },
	createElement: () => fakeElement(),
	createTextNode: () => fakeElement(),
	addEventListener: () => {},
});

afterAll(() => {
	vi.unstubAllGlobals();
});

function fakeElement() {
	return {
		style: {
			setProperty: () => {},
			removeProperty: () => {},
		},
		textContent: "",
		setAttribute: () => {},
		toggleAttribute: () => {},
		appendChild: () => {},
		remove: () => {},
	};
}

/** A configured user profile: non-default values the default store lacks. */
function hostFixture(): AppSettings {
	const host = structuredClone(DEFAULT_SETTINGS);
	host.onboardingDone = true;
	host.locale = "zh-CN";
	host.networkProxyEnabled = true;
	host.networkProxyUrl = "http://127.0.0.1:7890";
	host.translate = {
		...host.translate,
		providerConfigs: {
			deepl: { apiKey: "sk-host-live", baseUrl: "", region: "", model: "" },
		},
	};
	return host;
}

/** Fresh module registry: react-store first, then the real settings boot. */
async function loadWindow() {
	vi.resetModules();
	const reactStore = await import("@/lib/settings/react-store");
	await import("../src/main");
	await vi.waitFor(() => {
		if (h.renders.length === 0)
			throw new Error("settings window never rendered");
	});
	return reactStore;
}

beforeEach(() => {
	h.host = hostFixture();
	h.setCalls.length = 0;
	h.listeners.length = 0;
	h.renders.length = 0;
});

describe("settings window boot", () => {
	it("hydrates the settings store from Host before a patch can persist", async () => {
		const reactStore = await loadWindow();

		// Boot done; the store the settings window shares must hold the Host
		// profile, not the module-import-time defaults the boot started with.
		const settings = reactStore.getSettings();
		expect(settings.onboardingDone).toBe(true);
		expect(settings.locale).toBe("zh-CN");
		expect(settings.networkProxyUrl).toBe("http://127.0.0.1:7890");
		expect(settings.translate.providerConfigs.deepl?.apiKey).toBe(
			"sk-host-live",
		);

		// Settings edits persist a full snapshot; it must carry the hydrated
		// Host values, not defaults.
		reactStore.patchSettings({ onboardingDone: false });
		await vi.waitFor(() => {
			if (h.setCalls.length === 0) throw new Error("settings_set never fired");
		});
		const saved = h.setCalls[0];
		expect(saved.onboardingDone).toBe(false);
		expect(saved.locale).toBe("zh-CN");
		expect(saved.networkProxyUrl).toBe("http://127.0.0.1:7890");
		expect(saved.translate.providerConfigs.deepl?.apiKey).toBe("sk-host-live");
	});

	it("applies settings:changed broadcasts to the same store", async () => {
		const reactStore = await loadWindow();
		const next = hostFixture();
		next.locale = "en";
		const listener = h.listeners.find((l) => l.name === "settings:changed");
		expect(listener).toBeDefined();
		listener?.cb({ payload: next });
		await vi.waitFor(() => {
			if (reactStore.getSettings().locale !== "en")
				throw new Error("broadcast not applied");
		});
	});
});
