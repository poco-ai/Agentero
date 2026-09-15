import { useCallback, useEffect, useMemo, useState } from "react";
import type { SettingsSection } from "@/components/settings/types";
import { TrafficLightSpacer } from "@/components/shell/traffic-light-spacer";
import { applyLocale } from "@/i18n";
import { commands } from "@/lib/core/bindings";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import {
	applyDocumentChrome,
	ensureSettingsLoaded,
	loadSettings,
	saveSettingsAsync,
	subscribeSettings,
} from "@/lib/settings";
import { SettingsContent } from "./settings-content";

function readSearchParams() {
	const params = new URLSearchParams(window.location.search);
	const section = (params.get("section") ?? "general") as SettingsSection;
	const vaultPath = params.get("vault_path");
	return { section, vaultPath };
}

function closeCurrentWindow() {
	void (async () => {
		if (!isTauri()) return;
		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			await getCurrentWindow().close();
		} catch (e) {
			console.warn("[settings-native-root] close failed", e);
		}
	})();
}

/**
 * Native Settings window chrome + content.
 *
 * Loaded by `main.tsx` when `?window=settings` is present. It does not mount
 * the full `App`, so the second webview stays lightweight.
 */
export function SettingsNativeRoot() {
	const [{ section, vaultPath }, setSearchParams] = useState(readSearchParams);
	const [settings, setSettings] = useState(loadSettings);
	const isMac = useMemo(() => isMacOS(), []);

	useEffect(() => {
		let cancelled = false;
		void ensureSettingsLoaded().then(() => {
			if (!cancelled) setSettings(loadSettings());
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		return subscribeSettings((next) => {
			setSettings(next);
		});
	}, []);

	// Mirror main-window chrome (scale + interface/mono fonts) so pickers preview live.
	useEffect(() => {
		applyDocumentChrome({
			uiScale: settings.uiScale,
			interfaceFontFamily: settings.interfaceFontFamily,
			monoFontFamily: settings.monoFontFamily,
		});
	}, [settings.uiScale, settings.interfaceFontFamily, settings.monoFontFamily]);

	// Settings webview does not mount `useAppBootstrap`; apply locale here so
	// Appearance → Language switches the settings UI immediately (Fix #437).
	useEffect(() => {
		const resolved = applyLocale(settings.locale);
		if (!isTauri()) return;
		void (async () => {
			try {
				await commands.setLocale(resolved);
			} catch {
				// Native menu keeps its previous locale; non-fatal.
			}
		})();
	}, [settings.locale]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const isComma = event.key === "," || event.code === "Comma";
			const isEsc = event.key === "Escape";
			const isCloseWindow =
				(event.key === "w" || event.code === "KeyW") &&
				(event.metaKey || event.ctrlKey);
			const metaOrCtrl = event.metaKey || event.ctrlKey;
			if (
				isEsc ||
				(isCloseWindow && !event.altKey && !event.shiftKey) ||
				(isComma && metaOrCtrl && !event.altKey && !event.shiftKey)
			) {
				event.preventDefault();
				closeCurrentWindow();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const handleSectionChange = useCallback((next: SettingsSection) => {
		setSearchParams((prev) => ({ ...prev, section: next }));
		const url = new URL(window.location.href);
		url.searchParams.set("section", next);
		window.history.replaceState(null, "", url.toString());
	}, []);

	const handleChange = useCallback(async (next: typeof settings) => {
		setSettings(next);
		try {
			await saveSettingsAsync(next);
		} catch (e) {
			console.warn("[settings-native-root] save failed", e);
		}
	}, []);

	return (
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
			{/*
			  Window chrome: macOS reserves a drag strip for the native traffic
			  lights (Overlay title bar). Windows / Linux use native decorations,
			  so the OS title bar already provides the title and caption buttons.
			*/}
			{isMac ? (
				<header
					data-settings-titlebar
					className="flex h-8 shrink-0 items-center border-b border-sidebar-border/80 bg-sidebar/80 backdrop-blur-xl backdrop-saturate-150 select-none supports-backdrop-blur:bg-sidebar/65"
				>
					{/*
					  Traffic lights: x=14, three ~14px buttons + gaps → ends ~68px.
					  Keep the same reserved strip as the main title bar so the drag
					  region layout matches across windows (collapses in native
					  fullscreen, where the lights are hidden), then let the rest of
					  the header be draggable too.
					*/}
					<TrafficLightSpacer />
					<div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
				</header>
			) : null}

			{/* Content */}
			<div className="flex min-h-0 flex-1">
				<SettingsContent
					section={section}
					onSectionChange={handleSectionChange}
					settings={settings}
					onChange={handleChange}
					vaultPath={vaultPath}
				/>
			</div>
		</div>
	);
}
