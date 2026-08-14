import { motion, useReducedMotion } from "motion/react";
import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/core/utils";
import {
	formatThoughtLineText,
	type ThoughtLine,
	type ThoughtStreamState,
	watchCommitteeThoughts,
} from "@/lib/voice-defense";

/**
 * Ambient reasoning backdrop for the preparation stage: the committees' live
 * thought stream rendered as a faint wall of text behind the hero. It is
 * decoration built from real activity — every line is a streamed thought or
 * tool action, so the page only "breathes" while the models actually work.
 * Memory-only; nothing rendered here is persisted.
 */

const ACTIVITY_WINDOW_MS = 5_000;

/**
 * Recency fade: the newest line is the bright "thinking edge", older lines
 * dissolve upwards. A uniform alpha reads as smudge on light themes; the
 * gradient reads as intent.
 */
const NEWEST_LINE_OPACITY = 0.34;
const OLDEST_LINE_OPACITY = 0.05;
const OPACITY_FALLOFF_PER_LINE = 0.03;

function lineOpacity(fromBottom: number): number {
	return Math.max(
		OLDEST_LINE_OPACITY,
		NEWEST_LINE_OPACITY - fromBottom * OPACITY_FALLOFF_PER_LINE,
	);
}

function ThoughtColumn({
	lines,
	animate,
}: {
	lines: ThoughtLine[];
	animate: boolean;
}) {
	return (
		<div className="flex h-full min-w-0 flex-col justify-end overflow-hidden">
			{lines.map((line, index) => {
				const opacity = lineOpacity(lines.length - 1 - index);
				const text = formatThoughtLineText(line.text);
				return animate ? (
					<motion.p
						key={line.no}
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity, y: 0 }}
						transition={{ duration: 0.4, ease: "easeOut" }}
						className="min-h-5 shrink-0 break-words font-mono text-[11px] leading-5"
					>
						{text}
					</motion.p>
				) : (
					<p
						key={line.no}
						style={{ opacity }}
						className="min-h-5 shrink-0 break-words font-mono text-[11px] leading-5"
					>
						{text}
					</p>
				);
			})}
		</div>
	);
}

export function ThoughtBackdropView({
	analysis,
	review,
	active,
}: {
	analysis: ThoughtLine[];
	review: ThoughtLine[];
	active: boolean;
}) {
	const reducedMotion = useReducedMotion();
	if (analysis.length === 0 && review.length === 0) return null;
	return (
		<div
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-0 select-none overflow-hidden transition-opacity duration-1000",
				active ? "opacity-100" : "opacity-40",
			)}
		>
			{/* Nested masks intersect: vertical fade + a center hole for the hero. */}
			<div className="h-full [mask-image:linear-gradient(to_bottom,transparent_0%,black_30%,black_86%,transparent_100%)]">
				<div className="grid h-full grid-cols-2 gap-12 px-8 pt-14 pb-6 text-foreground [mask-image:radial-gradient(ellipse_46%_44%_at_50%_46%,transparent_36%,black_76%)]">
					<ThoughtColumn lines={analysis} animate={!reducedMotion} />
					<ThoughtColumn lines={review} animate={!reducedMotion} />
				</div>
			</div>
		</div>
	);
}

/** Live wrapper: subscribes to the run's thought stream while it is active. */
export const ThoughtBackdrop = memo(function ThoughtBackdrop({
	runId,
}: {
	runId: string | null;
}) {
	const [state, setState] = useState<ThoughtStreamState | null>(null);
	// Re-evaluate the activity window even when no new events arrive.
	const [, setPulse] = useState(0);

	useEffect(() => {
		setState(null);
		if (!runId) return;
		return watchCommitteeThoughts({ runId, onUpdate: setState });
	}, [runId]);

	useEffect(() => {
		if (!runId) return;
		const id = window.setInterval(() => setPulse((value) => value + 1), 2_500);
		return () => window.clearInterval(id);
	}, [runId]);

	if (!runId || !state) return null;
	const active =
		state.lastEventAt !== null &&
		Date.now() - state.lastEventAt < ACTIVITY_WINDOW_MS;
	return (
		<ThoughtBackdropView
			analysis={state.analysis}
			review={state.review}
			active={active}
		/>
	);
});
