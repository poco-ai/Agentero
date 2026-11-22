/** Two resumable tours: the empty workspace first, then a paper's reading tools. */
import { type Driver, type DriveStep, driver } from "driver.js";
import "driver.js/dist/driver.css";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { onboardingStore } from "@/components/onboarding/onboarding-store";
import { useSettings, useVaultStore } from "@/hooks/use-app-stores";
import { perfActive } from "@/lib/core/perf";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { listenTourRequest } from "@/lib/onboarding/api";
import {
	advanceTourPhase,
	readTourProgress,
	resetTourProgress,
	saveTourProgress,
	type TourPhase,
} from "@/lib/onboarding/tour-progress";
import { patchSettings } from "@/lib/settings/react-store";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import { layout, uiStore } from "@/lib/shell/ui-store";
import { openRightTab } from "@/lib/shell/ui-window-actions";
import { setNotesSplit } from "@/lib/workspace/actions";
import { getActiveTab } from "@/lib/workspace/store";

type TourTarget = {
	selector?: string;
	key: string;
	side?: "left" | "right" | "top" | "bottom";
};
const workspaceTargets = [
	{ selector: "[data-vault-sidebar]", key: "sidebar", side: "right" },
	{ selector: "[data-library-row]", key: "library", side: "right" },
	{ selector: "[data-cool-papers]", key: "coolPapers", side: "right" },
	{ selector: "[data-magic-wand]", key: "magicWand", side: "bottom" },
	{ selector: ".agentero-dockview", key: "workspace", side: "top" },
	{ selector: "[data-agent-panel]", key: "agent", side: "left" },
	{ selector: "[data-titlebar]", key: "titlebar", side: "bottom" },
	{ selector: undefined, side: undefined, key: "workspaceNext" },
] as const satisfies readonly TourTarget[];
const readingTargets = [
	{ selector: "[data-pdf-root]", key: "readPaper", side: "right" },
	{ selector: "[data-paper-notes]", key: "notes", side: "left" },
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
	{ selector: "[data-pdf-root]", key: "annotations", side: "right" },
	{ selector: "[data-pdf-root]", key: "selectionTranslate", side: "right" },
	{ selector: undefined, side: undefined, key: "readingNext" },
] as const satisfies readonly TourTarget[];

function visibleTarget(selector: string): HTMLElement | undefined {
	return [...document.querySelectorAll<HTMLElement>(selector)].find(
		(element) => element.getClientRects().length > 0,
	);
}

/** Modal dialogs always own the interaction surface; a tour never wins by z-index. */
function blocked(): boolean {
	const onboarding = onboardingStore.getState();
	const ui = uiStore.getState();
	return (
		onboarding.open ||
		onboarding.vaultSetupPending ||
		ui.zoteroOpen ||
		ui.alphaxivOpen ||
		ui.zoteroSyncOpen ||
		ui.commandOpen ||
		ui.settingsOpen ||
		ui.immersiveReading ||
		[
			...document.querySelectorAll<HTMLElement>(
				'[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
			),
		].some(
			(element) =>
				element.getClientRects().length > 0 &&
				!element.closest(".driver-popover"),
		)
	);
}

export function useFeatureTour(): void {
	const { t } = useTranslation("onboarding");
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const featureTourDone = useSettings((s) => s.featureTourDone);
	useEffect(() => {
		if (!isTauri() || isMobileApp() || perfActive() || !vaultPath) return;
		let active: Driver | null = null;
		let disposed = false;
		let paused = false;
		let interrupted = false;
		let complete = featureTourDone;
		let timer: number | undefined;
		let prepared: string | null = null;

		const stop = () => {
			interrupted = true;
			active?.destroy();
			active = null;
		};
		const schedule = () => {
			if (disposed) return;
			if (
				active &&
				(blocked() ||
					(active.getActiveElement() &&
						!active.getActiveElement()?.isConnected))
			)
				stop();
			if (active || paused || complete || timer !== undefined) return;
			timer = window.setTimeout(start, 800);
		};
		const start = () => {
			timer = undefined;
			if (disposed || paused || complete || active || blocked()) return;
			const progress = readTourProgress();
			const phase: TourPhase = progress.workspaceDone ? "reading" : "workspace";
			if (phase === "reading" && !visibleTarget("[data-pdf-root]")) return;
			const paper = getActiveTab();
			const preparation = phase === "reading" ? paper?.notesPath : phase;
			if (phase === "reading" && !preparation) return;
			if (prepared !== preparation) {
				prepared = preparation ?? null;
				layout()?.setLeftCollapsed(false);
				if (phase === "workspace") openRightTab("agent");
				else {
					setNotesSplit(true);
				}
			}
			const targets = phase === "workspace" ? workspaceTargets : readingTargets;
			const elements = targets.map((target) =>
				target.selector ? visibleTarget(target.selector) : undefined,
			);
			// No filtering: a missing reading tool defers this phase instead of
			// permanently claiming the user has seen an unavailable feature.
			if (targets.some((target, index) => target.selector && !elements[index]))
				return;
			if (blocked()) return;
			let finished = false;
			const steps: DriveStep[] = targets.map((target, index) => ({
				element: elements[index],
				popover: {
					title: t(`tour.${target.key}.title`),
					description: t(`tour.${target.key}.desc`, {
						magicWandShortcut: formatShortcutById("magicWand"),
						settingsShortcut: formatShortcutById("settings"),
						quickOpenShortcut: formatShortcutById("quickOpen"),
					}),
					side: target.side,
					align: "start",
				},
			}));
			interrupted = false;
			active = driver({
				steps,
				showProgress: true,
				animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
				smoothScroll: false,
				allowKeyboardControl: true,
				overlayClickBehavior: "close",
				stagePadding: 4,
				stageRadius: 8,
				progressText: "{{current}} / {{total}}",
				nextBtnText: t("tour.next"),
				prevBtnText: t("tour.back"),
				doneBtnText: t("tour.done"),
				onHighlighted: (_element, _step, { state }) =>
					saveTourProgress({
						...readTourProgress(),
						phase,
						step: state.activeIndex ?? 0,
					}),
				onDoneClick: (_element, _step, { driver: instance }) => {
					finished = true;
					const next = advanceTourPhase(readTourProgress(), phase);
					saveTourProgress(next);
					if (next.workspaceDone && next.readingDone) {
						complete = true;
						patchSettings({ featureTourDone: true });
					}
					instance.destroy();
				},
				onDestroyed: (_element, _step, { state }) => {
					if (!finished)
						saveTourProgress({
							...readTourProgress(),
							phase,
							step: state.activeIndex ?? 0,
						});
					active = null;
					paused = !finished && !interrupted;
					if (!disposed && !paused) schedule();
				},
			});
			active.drive(
				progress.phase === phase
					? Math.min(progress.step, steps.length - 1)
					: 0,
			);
		};
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["role", "aria-modal", "data-state"],
		});
		const offUi = uiStore.subscribe(schedule);
		const offOnboarding = onboardingStore.subscribe(schedule);
		let offReplay: (() => void) | undefined;
		void listenTourRequest(() => {
			stop();
			resetTourProgress();
			complete = false;
			paused = false;
			prepared = null;
			patchSettings({ featureTourDone: false });
			schedule();
		}).then((off) => {
			if (disposed) off();
			else offReplay = off;
		});
		schedule();
		return () => {
			disposed = true;
			window.clearTimeout(timer);
			observer.disconnect();
			offUi();
			offOnboarding();
			offReplay?.();
			stop();
		};
	}, [vaultPath, featureTourDone, t]);
}
