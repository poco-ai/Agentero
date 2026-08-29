/**
 * First-vault feature tour: a short driver.js highlight walkthrough that maps
 * the workspace for new users (sidebar → magic wand → workspace → Agent →
 * title bar). Auto-starts once a vault is open and `featureTourDone` is
 * false; Settings can replay it via a cross-window event.
 */

import { type Driver, driver } from "driver.js";
import "driver.js/dist/driver.css";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, useVaultStore } from "@/hooks/use-app-stores";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { listenTourRequest } from "@/lib/onboarding/api";
import { patchSettings } from "@/lib/settings/react-store";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import { layout } from "@/lib/shell/ui-store";
import { openRightTab } from "@/lib/shell/ui-window-actions";

const MAGIC_WAND_SHORTCUT = formatShortcutById("magicWand");
const SETTINGS_SHORTCUT = formatShortcutById("settings");
const QUICK_OPEN_SHORTCUT = formatShortcutById("quickOpen");

/** Poll for a lazily-mounted target; resolves false when it never appears. */
function waitForElement(selector: string, timeoutMs = 2500): Promise<boolean> {
	return new Promise((resolve) => {
		if (document.querySelector(selector)) {
			resolve(true);
			return;
		}
		const started = performance.now();
		const timer = window.setInterval(() => {
			if (document.querySelector(selector)) {
				window.clearInterval(timer);
				resolve(true);
			} else if (performance.now() - started > timeoutMs) {
				window.clearInterval(timer);
				resolve(false);
			}
		}, 50);
	});
}

let activeDriver: Driver | null = null;

/**
 * Start the feature tour. Ensures the highlighted regions are mounted (left
 * rail expanded, Agent panel opened) before driving; steps whose target never
 * appears are dropped.
 */
async function startTour(t: TFunction<"onboarding">): Promise<void> {
	activeDriver?.destroy();

	// Targets that may be collapsed/lazy: expand the left rail and mount the
	// Agent panel so their elements exist before the steps resolve.
	layout()?.setLeftCollapsed(false);
	openRightTab("agent");

	const candidates = [
		{ selector: "[data-vault-sidebar]", key: "sidebar", side: "right" },
		{ selector: "[data-magic-wand]", key: "magicWand", side: "bottom" },
		{ selector: ".agentero-dockview", key: "workspace", side: "top" },
		{ selector: "[data-agent-panel]", key: "agent", side: "left" },
		{ selector: "[data-titlebar]", key: "titlebar", side: "bottom" },
	] as const;

	const found = await Promise.all(
		candidates.map((c) => waitForElement(c.selector)),
	);
	const steps = candidates
		.filter((_, i) => found[i])
		.map((c) => ({
			element: c.selector,
			popover: {
				title: t(`tour.${c.key}.title`),
				description: t(`tour.${c.key}.desc`, {
					magicWandShortcut: MAGIC_WAND_SHORTCUT,
					settingsShortcut: SETTINGS_SHORTCUT,
					quickOpenShortcut: QUICK_OPEN_SHORTCUT,
				}),
				side: c.side,
				align: "start" as const,
			},
		}));
	if (steps.length === 0) return;

	activeDriver = driver({
		showProgress: true,
		smoothScroll: true,
		allowKeyboardControl: false,
		// Clicking the dimmed overlay advances instead of quitting (default is
		// "close", which ends the tour on any stray click); the × button still
		// skips explicitly.
		overlayClickBehavior: "nextStep",
		stagePadding: 4,
		stageRadius: 8,
		progressText: "{{current}} / {{total}}",
		nextBtnText: t("tour.next"),
		prevBtnText: t("tour.back"),
		doneBtnText: t("tour.done"),
		steps,
		onDestroyed: () => {
			activeDriver = null;
			patchSettings({ featureTourDone: true });
		},
	});
	activeDriver.drive();
}

/** Auto-start on first vault open + replay listener (Settings → main). */
export function useFeatureTour(): void {
	const { t } = useTranslation("onboarding");
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const featureTourDone = useSettings((s) => s.featureTourDone);
	const startedRef = useRef(false);

	const start = useCallback(() => {
		void startTour(t);
	}, [t]);

	// Auto-start: first time a vault is active and the tour was never seen.
	// Delay lets the tree / workspace settle before highlighting.
	useEffect(() => {
		if (!isTauri() || isMobileApp()) return;
		if (!vaultPath || featureTourDone || startedRef.current) return;
		startedRef.current = true;
		const timer = window.setTimeout(start, 800);
		return () => window.clearTimeout(timer);
	}, [vaultPath, featureTourDone, start]);

	// Settings → main event: replay on demand.
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void listenTourRequest(() => {
			start();
		}).then((off) => {
			if (cancelled) off();
			else unlisten = off;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [start]);

	// Never leave the overlay behind on unmount.
	useEffect(() => {
		return () => {
			activeDriver?.destroy();
			activeDriver = null;
		};
	}, []);
}
