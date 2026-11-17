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
import { useStore } from "zustand";
import { onboardingStore } from "@/components/onboarding/onboarding-store";
import { useSettings, useUiStore, useVaultStore } from "@/hooks/use-app-stores";
import { perfActive } from "@/lib/core/perf";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { listenTourRequest } from "@/lib/onboarding/api";
import { patchSettings } from "@/lib/settings/react-store";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import { layout } from "@/lib/shell/ui-store";
import { openRightTab } from "@/lib/shell/ui-window-actions";

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
		{ selector: "[data-library-row]", key: "library", side: "right" },
		{ selector: "[data-cool-papers]", key: "coolPapers", side: "right" },
		{ selector: "[data-magic-wand]", key: "magicWand", side: "bottom" },
		{ selector: "[data-read-paper]", key: "readPaper", side: "right" },
		{ selector: ".agentero-dockview", key: "workspace", side: "top" },
		{
			selector: "[data-full-text-translate]",
			key: "fullTextTranslate",
			side: "bottom",
		},
		{
			selector: "[data-fetch-cool-papers-notes]",
			key: "fetchCoolPapersNotes",
			side: "bottom",
		},
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
					magicWandShortcut: formatShortcutById("magicWand"),
					settingsShortcut: formatShortcutById("settings"),
					quickOpenShortcut: formatShortcutById("quickOpen"),
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
		onDoneClick: (_element, _step, { driver: instance }) => {
			patchSettings({ featureTourDone: true });
			instance.destroy();
		},
		onDestroyed: () => {
			activeDriver = null;
		},
	});
	activeDriver.drive();
}

/** Auto-start on first vault open + replay listener (Settings → main). */
export function useFeatureTour(): void {
	const { t } = useTranslation("onboarding");
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const featureTourDone = useSettings((s) => s.featureTourDone);
	const onboardingOpen = useStore(onboardingStore, (s) => s.open);
	const setupPending = useStore(onboardingStore, (s) => s.vaultSetupPending);
	const modalOpen = useUiStore(
		(s) =>
			s.zoteroOpen ||
			s.zoteroSyncOpen ||
			s.commandOpen ||
			s.settingsOpen ||
			s.immersiveReading,
	);
	const startedRef = useRef(false);

	const start = useCallback(() => {
		void startTour(t);
	}, [t]);

	// Auto-start: first time a vault is active, the tour was never seen, and the
	// onboarding wizard is closed. Waiting for the wizard to dismiss prevents the
	// highlight tour from racing with the onboarding overlay.
	useEffect(() => {
		if (perfActive()) return;
		if (!isTauri() || isMobileApp()) return;
		if (
			!vaultPath ||
			featureTourDone ||
			startedRef.current ||
			onboardingOpen ||
			setupPending ||
			modalOpen
		)
			return;
		const timer = window.setTimeout(() => {
			startedRef.current = true;
			start();
		}, 800);
		return () => window.clearTimeout(timer);
	}, [
		vaultPath,
		featureTourDone,
		start,
		onboardingOpen,
		setupPending,
		modalOpen,
	]);

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
