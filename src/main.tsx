import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { HintModeProvider } from "@/components/shell/hint-mode-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { initLogger, logger } from "@/lib/core/logger";
import { notifyError, notifyReminder } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { initPaintOptimizations } from "@/lib/core/paint-perf";
import { perfActive, perfEmit } from "@/lib/core/perf";
import { initAutoHideScrollbars } from "@/lib/core/scrollbars";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import {
	applyDocumentChrome,
	ensureSettingsLoaded,
	initSettingsSync,
	loadSettings,
	subscribeSettings,
} from "@/lib/settings";
import { initSettingsStore } from "@/lib/settings/react-store";
import { applyNativeWindowTheme } from "@/lib/shell/native-window-theme";
import { initShellLayoutFromPrefs } from "@/lib/shell/ui-store";
import { applyUiTheme } from "@/lib/ui/theme";
import {
	checkForUpdate,
	getUpdateReleaseUrl,
	installAvailableUpdate,
} from "@/lib/update";
import { initVaultStore } from "@/lib/vault/store";
import { initWorkspaceStore } from "@/lib/workspace/store";
import i18n, { applyLocale } from "./i18n";
import "./index.css";

window.addEventListener("error", (e) => {
	const location = e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : "";
	logger.error(`[window.error] ${e.message}${location}`);
});
window.addEventListener("unhandledrejection", (e) => {
	const reason =
		e.reason instanceof Error
			? e.reason.stack || e.reason.message
			: String(e.reason);
	logger.error(`[unhandledrejection] ${reason}`);
});

const searchParams = new URLSearchParams(window.location.search);
const windowKind = searchParams.get("window");
const isSettingsWindow = windowKind === "settings";
const isFeatureWindow = windowKind === "feature";
const isDocWindow = windowKind === "doc";

// `performance.now()` is measured from navigation start, so these numbers cover
// index.html + main.tsx module loading too, not just the boot chain. `boot` is a
// serial await chain and in dev every step is a module request, so a slow window
// needs per-stage numbers to be actionable rather than guesswork.
const bootElapsed = () => Math.round(performance.now());
let bootMark = 0;
function bootStage(name: string) {
	const now = bootElapsed();
	logger.info(`boot stage=${name} ms=${now}`);
	perfEmit(`boot.${name}`, (now - bootMark) * 1000);
	bootMark = now;
}

async function boot() {
	void initLogger();
	logger.info("op start frontend_boot");
	bootStage("entry");

	// Host XDG settings.json (migrates legacy localStorage once).
	await ensureSettingsLoaded();
	// Every window must hydrate the React mirror before it can patch settings.
	initSettingsStore();
	bootStage("settings");
	initSettingsSync();
	const initialSettings = loadSettings();
	// Native caption (Windows / Linux) follows the stored preference from the
	// first frame; the subscription below keeps later changes in sync.
	applyNativeWindowTheme(initialSettings.theme);
	// Apply scale + interface/mono fonts before first paint so settings/main
	// windows do not flash the stylesheet default then switch.
	applyDocumentChrome({
		uiScale: initialSettings.uiScale,
		interfaceFontFamily: initialSettings.interfaceFontFamily,
		monoFontFamily: initialSettings.monoFontFamily,
	});
	await applyUiTheme(initialSettings.uiTheme).catch((e) => {
		console.warn("[theme] failed to apply initial UI theme", e);
	});
	bootStage("theme");
	subscribeSettings((s) => {
		void applyUiTheme(s.uiTheme);
		applyNativeWindowTheme(s.theme);
		applyDocumentChrome({
			uiScale: s.uiScale,
			interfaceFontFamily: s.interfaceFontFamily,
			monoFontFamily: s.monoFontFamily,
		});
		// Keep every window (settings / feature / doc / main) in sync when
		// locale changes elsewhere. SettingsNativeRoot also applies locally
		// for an immediate switch before the Host round-trip.
		applyLocale(s.locale);
	});
	initAutoHideScrollbars();
	initPaintOptimizations();
	applyLocale(initialSettings.locale);
	bootStage("i18n");

	const root = document.getElementById("root") as HTMLElement;
	// Every Tauri window is its own webview with its own document, so window
	// level keyboard handling (F hint mode) only exists where it is mounted.
	// The main window mounts `HintModeProvider` inside App.tsx; the settings,
	// feature and doc roots below wrap theirs here. A new window root must do
	// the same or `F` silently does nothing there.
	if (isSettingsWindow) {
		// Load the shell and the pane for the requested section together: the pane
		// is behind `lazy()`, so leaving it until after render would stall the
		// window right when it first looks interactive.
		const [{ SettingsNativeRoot }] = await Promise.all([
			import("@/components/settings/settings-native-root"),
			import("@/components/settings/settings-content").then((m) =>
				m.preloadSettingsPane(searchParams.get("section") ?? "general"),
			),
		]);
		bootStage("settings-module");
		ReactDOM.createRoot(root).render(
			<React.StrictMode>
				<I18nextProvider i18n={i18n}>
					<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
						<TooltipProvider delayDuration={300}>
							<HintModeProvider>
								<SettingsNativeRoot />
							</HintModeProvider>
							{/* Global error / notice stack (top-right); use notifyError from @/lib/notify */}
							<Toaster />
						</TooltipProvider>
					</ThemeProvider>
				</I18nextProvider>
			</React.StrictMode>,
		);
		logger.info(
			`op end frontend_boot ok=true duration_ms=${bootElapsed()} window=settings`,
		);
		return;
	}

	const { SelectionChatPopover } = await import(
		"@/components/selection/selection-chat-popover"
	);

	if (isFeatureWindow) {
		const { FeatureWindowRoot } = await import(
			"@/components/shell/feature-window-root"
		);
		bootStage("feature-window-module");
		initVaultStore();
		initWorkspaceStore();
		ReactDOM.createRoot(root).render(
			<React.StrictMode>
				<I18nextProvider i18n={i18n}>
					<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
						<TooltipProvider delayDuration={300}>
							<HintModeProvider>
								<FeatureWindowRoot />
							</HintModeProvider>
							<SelectionChatPopover />
							<Toaster />
						</TooltipProvider>
					</ThemeProvider>
				</I18nextProvider>
			</React.StrictMode>,
		);
		logger.info(
			`op end frontend_boot ok=true duration_ms=${bootElapsed()} window=feature`,
		);
		return;
	}

	if (isDocWindow) {
		// Doc windows may show PDF — need PDFium host; KaTeX for markdown notes.
		const [{ DocWindowRoot }, { PdfEngineHost }, { EditorDndProvider }] =
			await Promise.all([
				import("@/components/shell/doc-window-root"),
				import("@/components/viewer/pdf/engine-provider"),
				import("@/components/editor/plugins/dnd-kit"),
				import("katex/dist/katex.min.css"),
			]);
		bootStage("doc-window-module");
		initVaultStore();
		initWorkspaceStore();
		ReactDOM.createRoot(root).render(
			<PdfEngineHost>
				{/* HTML5Backend cannot remount under StrictMode — drag sources go dead. */}
				<EditorDndProvider>
					<React.StrictMode>
						<I18nextProvider i18n={i18n}>
							<ThemeProvider
								attribute="class"
								defaultTheme="system"
								enableSystem
							>
								<TooltipProvider delayDuration={300}>
									<HintModeProvider>
										<DocWindowRoot />
									</HintModeProvider>
									<SelectionChatPopover />
									<Toaster />
								</TooltipProvider>
							</ThemeProvider>
						</I18nextProvider>
					</React.StrictMode>
				</EditorDndProvider>
			</PdfEngineHost>,
		);
		logger.info(
			`op end frontend_boot ok=true duration_ms=${bootElapsed()} window=doc`,
		);
		return;
	}

	// Lazy-load the full app so the settings window (which returns above) never
	// downloads/parses the heavyweight workspace bundle. The PDF engine host and
	// KaTeX styles ride along here for the same reason: the settings webview has
	// no viewer and no math, so it must not pay for PDFium or the KaTeX fonts.
	// Keep the engine host outside StrictMode below so dev effect replay cannot
	// initialize a second PDFium instance.
	const [{ default: App }, { PdfEngineHost }, { EditorDndProvider }] =
		await Promise.all([
			import(isMobileApp() ? "./components/mobile/mobile-app" : "./App"),
			import("@/components/viewer/pdf/engine-provider"),
			import("@/components/editor/plugins/dnd-kit"),
			import("katex/dist/katex.min.css"),
		]);
	bootStage("app-module");
	initVaultStore();
	initWorkspaceStore();
	if (!isMobileApp()) initShellLayoutFromPrefs();
	ReactDOM.createRoot(root).render(
		<PdfEngineHost>
			{/* HTML5Backend cannot remount under StrictMode — drag sources go dead. */}
			<EditorDndProvider>
				<React.StrictMode>
					<I18nextProvider i18n={i18n}>
						<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
							<TooltipProvider delayDuration={300}>
								<App />
								<SelectionChatPopover />
								{/* Global error / notice stack (top-right); use notifyError from @/lib/notify */}
								<Toaster />
							</TooltipProvider>
						</ThemeProvider>
					</I18nextProvider>
				</React.StrictMode>
			</EditorDndProvider>
		</PdfEngineHost>,
	);
	logger.info(
		`op end frontend_boot ok=true duration_ms=${bootElapsed()} window=main`,
	);
	perfEmit("frontend_boot", bootElapsed() * 1000, true, "window=main");
	if (perfActive()) return;
	void checkForStartupUpdate();
	// Install the same-version CLI, or re-align it after a GUI-only update.
	void syncCliAtStartup();
	// Layout model download is a Host background task; App mounts
	// `useLayoutModelPrefetch` to surface it in the tasks panel.
}

/** A single main window owns the background update notification. */
async function checkForStartupUpdate(): Promise<void> {
	if (!isTauri()) return;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		if (getCurrentWindow().label !== "main") return;
		const update = await checkForUpdate({ retryOnTimeout: true });
		if (update.phase !== "available" || !update.availableVersion) return;
		notifyReminder(
			i18n.t("settings:about.update.toastTitle", {
				version: update.availableVersion,
			}),
			{
				id: "app-update-available",
				description: i18n.t("settings:about.update.toastDescription"),
				dismissLabel: i18n.t("settings:about.update.releaseNotes"),
				onDismiss: () =>
					openExternalUrl(getUpdateReleaseUrl(update.availableVersion)),
				actionLabel: i18n.t("settings:about.update.downloadInstall"),
				onAction: () => {
					void installAvailableUpdate();
				},
			},
		);
	} catch (error) {
		logger.warn("op end updater_startup_check ok=false", {
			error: errorText(error),
		});
	}
}

/**
 * Install the same-version CLI on startup, or refresh it after a GUI update.
 * The Host preserves an explicit uninstall. Best-effort, silent on success.
 */
async function syncCliAtStartup(): Promise<void> {
	if (!isTauri()) return;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		if (getCurrentWindow().label !== "main") return;
		const { syncCliWithApp } = await import("@/lib/cli/api");
		// The updater publishes the desktop package and separate CLI archive
		// independently. A just-relaunched app can reach the new desktop build
		// before its matching CLI asset is downloadable, so retry installation.
		for (const delayMs of [0, 15_000, 60_000]) {
			if (delayMs > 0) {
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, delayMs);
				});
			}
			const outcome = await syncCliWithApp();
			if (outcome !== "failed") return;
		}
		notifyError(i18n.t("settings:about.cli.syncFailed"));
	} catch (error) {
		logger.warn("op end cli_sync ok=false", {
			error: errorText(error),
		});
	}
}

void boot().catch((e) => {
	// A failed boot used to leave an empty <body> with no key handlers, so the
	// window (especially the separate Settings webview) looked blank and could
	// not be dismissed from the keyboard. Surface the error and wire Esc/⌘W so
	// the window is always closable.
	console.error("[boot] failed", e);
	const root = document.getElementById("root");
	if (root) {
		root.textContent = `Failed to start: ${errorText(e)}`;
		root.setAttribute(
			"style",
			"padding:24px;font:13px system-ui;white-space:pre-wrap;",
		);
	}
	window.addEventListener("keydown", (event) => {
		const quit =
			event.key === "Escape" ||
			((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w");
		if (!quit) return;
		void import("@tauri-apps/api/window")
			.then(({ getCurrentWindow }) => getCurrentWindow().close())
			.catch(() => undefined);
	});
});
