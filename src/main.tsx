import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import {
	parseSettingsSection,
	SettingsWindowRoot,
} from "@/components/settings-window-root";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PdfEngineHost } from "@/components/viewer/embed/engine-provider";
import { initLogger, logger } from "@/lib/logger";
import { applyUiTheme } from "@/lib/ui-theme";
import {
	ensureSettingsLoaded,
	initSettingsSync,
	loadSettings,
	settingsStore,
} from "@/stores/settings-store";
import App from "./App";
import i18n, { resolveLocale } from "./i18n";
import "./index.css";

async function boot() {
	await initLogger();
	logger.info("op start frontend_boot");

	// Host XDG settings.json (migrates legacy localStorage once).
	await ensureSettingsLoaded();
	initSettingsSync();
	applyUiTheme(loadSettings().uiTheme);
	settingsStore.store.subscribe(
		(s) => s.settings.uiTheme,
		(uiTheme) => applyUiTheme(uiTheme),
	);
	const locale = resolveLocale(loadSettings().locale);
	await i18n.changeLanguage(locale);
	if (typeof document !== "undefined") {
		document.documentElement.lang = locale;
	}

	// `?window=settings` boots the standalone native settings window instead
	// of the full workspace (see Host `settings_window_open`).
	const params = new URLSearchParams(window.location.search);
	const root =
		params.get("window") === "settings" ? (
			<SettingsWindowRoot
				initialSection={parseSettingsSection(params.get("section"))}
				vaultPath={params.get("vault")}
			/>
		) : (
			<PdfEngineHost>
				<App />
			</PdfEngineHost>
		);

	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<I18nextProvider i18n={i18n}>
				<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
					<TooltipProvider delayDuration={300}>
						{root}
						{/* Global error / notice stack (top-right); use notifyError from @/lib/notify */}
						<Toaster />
					</TooltipProvider>
				</ThemeProvider>
			</I18nextProvider>
		</React.StrictMode>,
	);
}

void boot();
