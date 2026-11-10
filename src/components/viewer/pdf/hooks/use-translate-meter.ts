import {
	useMotionValueEvent,
	useReducedMotion,
	useSpring,
	useTransform,
} from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Keep the completed meter visible briefly before collapsing. */
const TRANSLATE_METER_LINGER_MS = 700;

/**
 * Cancelling retracts the fill before the chip closes. Without this the chip
 * collapses the instant it stops, which reads as "the click did something"
 * rather than "the job backed out". Tuned to the spring below so the fill
 * reaches zero before the collapse starts.
 */
const TRANSLATE_METER_RETRACT_MS = 340;

type TranslateMeterOptions = {
	layoutTranslateRunning: boolean;
	/** Final corrected preview is still building after items settled. */
	layoutTranslatePreparing?: boolean;
	/** Queued behind layout analysis; a click cancels the wait. */
	layoutTranslateWaiting?: boolean;
	/** 0–1 fill. Stays under full while the reflow preview is still blank. */
	layoutTranslateProgress?: number | null;
};

/**
 * Shared full-text translation meter state: the stage caption, a smoothed
 * percentage, the open/indeterminate flags, the brief "complete" linger, and
 * the cancel retract. The toolbar embeds it in its expandable translate button;
 * the dual-pane translation panel renders the same state as a floating chip.
 */
export function useTranslateMeter({
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateProgress = null,
}: TranslateMeterOptions) {
	const { t } = useTranslation("viewer");
	const busy =
		layoutTranslateRunning ||
		layoutTranslatePreparing ||
		layoutTranslateWaiting;
	const complete = layoutTranslateProgress === 1;
	const reduceMotion = useReducedMotion();
	const [lingerFull, setLingerFull] = useState(false);
	const [retracting, setRetracting] = useState(false);
	const wasTranslateBusyRef = useRef(false);
	// Layout effect: the retract flag must land in the same paint that clears
	// `busy`, otherwise the chip collapses for a frame and re-expands.
	useLayoutEffect(() => {
		if (busy) {
			wasTranslateBusyRef.current = true;
			setLingerFull(false);
			setRetracting(false);
			return;
		}
		if (!wasTranslateBusyRef.current) {
			setLingerFull(false);
			return;
		}
		wasTranslateBusyRef.current = false;
		if (complete) {
			setLingerFull(true);
			const id = window.setTimeout(
				() => setLingerFull(false),
				TRANSLATE_METER_LINGER_MS,
			);
			return () => window.clearTimeout(id);
		}
		if (reduceMotion) return;
		// Cancelled: keep the meter mounted until the fill has retracted to zero,
		// then let the chip collapse on its own.
		setRetracting(true);
		const id = window.setTimeout(
			() => setRetracting(false),
			TRANSLATE_METER_RETRACT_MS,
		);
		return () => window.clearTimeout(id);
	}, [busy, complete, reduceMotion]);

	const open = busy || lingerFull || retracting;
	const indeterminate =
		open &&
		!lingerFull &&
		!retracting &&
		(layoutTranslateWaiting || layoutTranslateProgress == null);
	const ratio = lingerFull
		? 1
		: retracting
			? 0
			: Math.max(0, Math.min(1, layoutTranslateProgress ?? 0));
	const smoothPercent = useSpring(0, { stiffness: 180, damping: 30 });
	const smoothWidth = useTransform(smoothPercent, (value) => `${value}%`);
	const [percent, setPercent] = useState(0);
	useMotionValueEvent(smoothPercent, "change", (value) =>
		setPercent(Math.round(value)),
	);
	useEffect(() => {
		const target = open && !indeterminate ? ratio * 100 : 0;
		if (reduceMotion || !open || indeterminate) smoothPercent.jump(target);
		else smoothPercent.set(target);
	}, [open, indeterminate, ratio, reduceMotion, smoothPercent]);

	const stage = lingerFull
		? t("pdf.layoutTranslate.phaseDone")
		: layoutTranslateWaiting
			? t("pdf.layoutTranslate.phaseLayout")
			: layoutTranslatePreparing
				? t("pdf.layoutTranslate.phaseTypeset")
				: indeterminate
					? t("pdf.layoutTranslate.phaseExtract")
					: t("pdf.layoutTranslate.phaseTranslate");

	return {
		busy,
		open,
		indeterminate,
		retracting,
		ratio,
		percent,
		stage,
		width: smoothWidth,
		lingerFull,
	};
}
