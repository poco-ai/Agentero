import {
	useMotionValueEvent,
	useReducedMotion,
	useSpring,
	useTransform,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Keep the completed meter visible briefly before collapsing. */
const TRANSLATE_METER_LINGER_MS = 700;

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
 * percentage, the open/indeterminate flags, and the brief "complete" linger.
 * The toolbar embeds it in its expandable translate button; the dual-pane
 * translation panel renders the same state as a floating chip.
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
	const [lingerFull, setLingerFull] = useState(false);
	const wasTranslateBusyRef = useRef(false);
	useEffect(() => {
		if (busy) {
			wasTranslateBusyRef.current = true;
			setLingerFull(false);
			return;
		}
		if (!complete) {
			setLingerFull(false);
			wasTranslateBusyRef.current = false;
			return;
		}
		if (!wasTranslateBusyRef.current) return;
		wasTranslateBusyRef.current = false;
		setLingerFull(true);
		const id = window.setTimeout(
			() => setLingerFull(false),
			TRANSLATE_METER_LINGER_MS,
		);
		return () => window.clearTimeout(id);
	}, [busy, complete]);

	const open = busy || lingerFull;
	const indeterminate =
		open &&
		!lingerFull &&
		(layoutTranslateWaiting || layoutTranslateProgress == null);
	const ratio = lingerFull
		? 1
		: Math.max(0, Math.min(1, layoutTranslateProgress ?? 0));
	const reduceMotion = useReducedMotion();
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
		ratio,
		percent,
		stage,
		width: smoothWidth,
		lingerFull,
	};
}
