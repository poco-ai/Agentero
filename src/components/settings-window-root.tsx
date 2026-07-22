import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsContent,
	type SettingsSection,
} from "@/components/settings-window";
import i18n, { resolveLocale } from "@/i18n";
import type { AppSettings } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";
import { saveSettings, useSettings } from "@/stores/settings-store";

const SECTIONS: SettingsSection[] = [
	"general",
	"appearance",
	"agent",
	"translate",
	"keyboard",
	"privacy",
	"about",
];

function parseSection(raw: string | null): SettingsSection {
	return SECTIONS.includes(raw as SettingsSection)
		? (raw as SettingsSection)
		: "general";
}

type SettingsWindowRootProps = {
	initialSection: SettingsSection;
	vaultPath: string | null;
};

/** Root of the standalone native settings window (`?window=settings`). */
export function SettingsWindowRoot({
	initialSection,
	vaultPath,
}: SettingsWindowRootProps) {
	const { t } = useTranslation(["settings"]);
	const { setTheme } = useTheme();
	const settings = useSettings();
	const [section, setSection] = useState<SettingsSection>(initialSection);

	const updateSettings = useCallback((next: AppSettings) => {
		saveSettings(next);
	}, []);

	useEffect(() => {
		setTheme(settings.theme);
	}, [settings.theme, setTheme]);

	useEffect(() => {
		const locale = resolveLocale(settings.locale);
		void i18n.changeLanguage(locale);
		if (typeof document !== "undefined") {
			document.documentElement.lang = locale;
		}
	}, [settings.locale]);

	// Native window title follows the UI language.
	useEffect(() => {
		if (!isTauri()) return;
		void (async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				await getCurrentWindow().setTitle(t("settings:title"));
			} catch {
				// Keep the default title from window creation.
			}
		})();
	}, [t]);

	// Deep-link navigation when an already-open window is re-opened (⌘, etc.).
	useEffect(() => {
		if (!isTauri()) return;
		let unlisten: (() => void) | null = null;
		let cancelled = false;
		void (async () => {
			try {
				const { listen } = await import("@tauri-apps/api/event");
				const off = await listen<{ section?: string | null }>(
					"settings:navigate",
					(event) => {
						const raw = event.payload?.section ?? null;
						if (raw) setSection(parseSection(raw));
					},
				);
				if (cancelled) off();
				else unlisten = off;
			} catch {
				// Navigation deep-link unavailable; window still works.
			}
		})();
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	// ⌘W closes the window (macOS utility-window convention; Esc is left to
	// in-window popovers/dialogs).
	useEffect(() => {
		if (!isTauri()) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			const closeCombo =
				(event.metaKey || event.ctrlKey) &&
				!event.shiftKey &&
				!event.altKey &&
				event.key.toLowerCase() === "w";
			if (!closeCombo) return;
			event.preventDefault();
			void (async () => {
				try {
					const { getCurrentWindow } = await import("@tauri-apps/api/window");
					await getCurrentWindow().close();
				} catch {
					// ignore
				}
			})();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
			<SettingsContent
				section={section}
				onSectionChange={setSection}
				settings={settings}
				onChange={updateSettings}
				vaultPath={vaultPath}
			/>
		</div>
	);
}

export { parseSection as parseSettingsSection };
