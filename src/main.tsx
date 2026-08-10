import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initLogger, logger } from "@/lib/core/logger";
import { notifyAction, notifyError } from "@/lib/core/notify";
import { initAutoHideScrollbars } from "@/lib/core/scrollbars";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { initErrorReporting } from "@/lib/core/telemetry";
import {
	ensureSettingsLoaded,
	initSettingsSync,
	loadSettings,
	subscribeSettings,
} from "@/lib/settings";
import { applyUiTheme } from "@/lib/ui/theme";
import { checkForUpdate, installAvailableUpdate } from "@/lib/update";
import i18n, { resolveLocale } from "./i18n";
import "./index.css";

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
function bootStage(name: string) {
	logger.info(`boot stage=${name} ms=${bootElapsed()}`);
}

async function boot() {
	void initLogger();
	initErrorReporting();
	logger.info("op start frontend_boot");
	bootStage("entry");

	// Host XDG settings.json (migrates legacy localStorage once).
	await ensureSettingsLoaded();
	bootStage("settings");
	initSettingsSync();
	await applyUiTheme(loadSettings().uiTheme).catch((e) => {
		console.warn("[theme] failed to apply initial UI theme", e);
	});
	bootStage("theme");
	subscribeSettings((s) => {
		void applyUiTheme(s.uiTheme);
	});
	initAutoHideScrollbars();
	const locale = resolveLocale(loadSettings().locale);
	await i18n.changeLanguage(locale);
	bootStage("i18n");
	if (typeof document !== "undefined") {
		document.documentElement.lang = locale;
	}

	const root = document.getElementById("root") as HTMLElement;
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
							<SettingsNativeRoot />
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

	if (isFeatureWindow) {
		const { FeatureWindowRoot } = await import(
			"@/components/shell/feature-window-root"
		);
		bootStage("feature-window-module");
		ReactDOM.createRoot(root).render(
			<React.StrictMode>
				<I18nextProvider i18n={i18n}>
					<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
						<TooltipProvider delayDuration={300}>
							<FeatureWindowRoot />
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
		const [{ DocWindowRoot }, { PdfEngineHost }] = await Promise.all([
			import("@/components/shell/doc-window-root"),
			import("@/components/viewer/pdf/engine-provider"),
			import("katex/dist/katex.min.css"),
		]);
		bootStage("doc-window-module");
		ReactDOM.createRoot(root).render(
			<PdfEngineHost>
				<React.StrictMode>
					<I18nextProvider i18n={i18n}>
						<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
							<TooltipProvider delayDuration={300}>
								<DocWindowRoot />
								<Toaster />
							</TooltipProvider>
						</ThemeProvider>
					</I18nextProvider>
				</React.StrictMode>
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
	const [{ default: App }, { PdfEngineHost }] = await Promise.all([
		import(isMobileApp() ? "./components/mobile/mobile-app" : "./App"),
		import("@/components/viewer/pdf/engine-provider"),
		import("katex/dist/katex.min.css"),
	]);
	bootStage("app-module");
	ReactDOM.createRoot(root).render(
		<PdfEngineHost>
			<React.StrictMode>
				<I18nextProvider i18n={i18n}>
					<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
						<TooltipProvider delayDuration={300}>
							<App />
							{/* Global error / notice stack (top-right); use notifyError from @/lib/notify */}
							<Toaster />
						</TooltipProvider>
					</ThemeProvider>
				</I18nextProvider>
			</React.StrictMode>
		</PdfEngineHost>,
	);
	logger.info(
		`op end frontend_boot ok=true duration_ms=${bootElapsed()} window=main`,
	);
	void checkForStartupUpdate();
	// Layout model download is a Host background task; App mounts
	// `useLayoutModelPrefetch` to surface it in the tasks panel.
}

/** A single main window owns the background update notification. */
async function checkForStartupUpdate(): Promise<void> {
	if (!isTauri()) return;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		if (getCurrentWindow().label !== "main") return;
		const update = await checkForUpdate();
		if (update.phase !== "available" || !update.availableVersion) return;
		notifyAction(
			i18n.t("settings:about.update.toastTitle", {
				version: update.availableVersion,
			}),
			{
				id: "app-update-available",
				description: i18n.t("settings:about.update.toastDescription"),
				actionLabel: i18n.t("settings:about.update.downloadInstall"),
				onAction: () => {
					void installAvailableUpdate().then((next) => {
						if (next.phase === "error") {
							notifyError(i18n.t("settings:about.update.installFailed"));
						}
					});
				},
			},
		);
	} catch (error) {
		logger.warn("op end updater_startup_check ok=false", {
			error: error instanceof Error ? error.message : String(error),
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
		root.textContent = `Failed to start: ${e instanceof Error ? e.message : String(e)}`;
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
