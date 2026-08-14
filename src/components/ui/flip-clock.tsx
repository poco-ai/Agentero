import { useReducedMotion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/core/utils";

/**
 * Split-flap flip clock in the spirit of open flip-countdown components
 * (react-flip-clock-countdown et al.), vendored because the stage needs
 * count-up, overtime ("+") and static-preview states that date-target
 * countdown libraries cannot express.
 *
 * Sizing is em-based: scale the whole clock with a `text-*` class, color the
 * digits with a text color class. Non-digit glyphs (":", "+") render as plain
 * separators.
 */

function DigitHalf({
	char,
	side,
	className,
	onAnimationEnd,
}: {
	char: string;
	side: "top" | "bottom";
	className?: string;
	onAnimationEnd?: (animationName: string) => void;
}) {
	return (
		<span
			className={cn(
				"absolute inset-x-0 h-1/2 overflow-hidden",
				side === "top"
					? "top-0 rounded-t-[0.1em] bg-[#1b1b1e]"
					: "bottom-0 rounded-b-[0.1em] bg-[#131316]",
				className,
			)}
			onAnimationEnd={
				onAnimationEnd
					? (event) => onAnimationEnd(event.animationName)
					: undefined
			}
		>
			<span
				className={cn(
					"absolute inset-x-0 flex h-[200%] items-center justify-center",
					side === "top" ? "top-0" : "bottom-0",
				)}
			>
				{char}
			</span>
		</span>
	);
}

function FlipDigit({
	char,
	animate,
	cardClassName,
}: {
	char: string;
	animate: boolean;
	cardClassName?: string;
}) {
	const [state, setState] = useState({ current: char, previous: char });
	if (state.current !== char) {
		setState({ current: char, previous: animate ? state.current : char });
	}
	const flipping = state.previous !== state.current;
	const settle = (animationName: string) => {
		if (animationName !== "flip-clock-bottom") return;
		setState((value) => ({ ...value, previous: value.current }));
	};

	return (
		<span
			className={cn(
				"relative h-[1.24em] w-[0.74em] [perspective:4em]",
				cardClassName,
			)}
		>
			<DigitHalf char={state.current} side="top" />
			<DigitHalf
				char={flipping ? state.previous : state.current}
				side="bottom"
			/>
			{flipping ? (
				<DigitHalf
					key={`top-${state.previous}-${state.current}`}
					char={state.previous}
					side="top"
					className="z-10 origin-bottom [animation:flip-clock-top_0.3s_ease-in_forwards] [backface-visibility:hidden]"
				/>
			) : null}
			{flipping ? (
				<DigitHalf
					key={`bottom-${state.previous}-${state.current}`}
					char={state.current}
					side="bottom"
					className="z-10 origin-top [animation:flip-clock-bottom_0.34s_0.28s_ease-out_both] [backface-visibility:hidden]"
					onAnimationEnd={settle}
				/>
			) : null}
			<span
				className="absolute inset-x-0 top-1/2 z-20 h-px -translate-y-1/2 bg-black/70"
				aria-hidden
			/>
		</span>
	);
}

export function FlipClock({
	value,
	className,
	cardClassName,
}: {
	/** Rendered glyphs, e.g. "20:00", "+0:12", "3:27". */
	value: string;
	/** Scale via `text-*`, digit color via a text color class. */
	className?: string;
	cardClassName?: string;
}) {
	const reducedMotion = useReducedMotion();
	return (
		<span
			role="timer"
			className={cn(
				"inline-flex items-center gap-[0.09em] font-semibold leading-none tabular-nums",
				className,
			)}
			aria-label={value}
		>
			{value.split("").map((char, index) =>
				/\d/.test(char) ? (
					<FlipDigit
						// biome-ignore lint/suspicious/noArrayIndexKey: glyph slots are positional
						key={index}
						char={char}
						animate={!reducedMotion}
						cardClassName={cardClassName}
					/>
				) : (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: glyph slots are positional
						key={index}
						className="flex w-[0.36em] items-center justify-center opacity-70"
						aria-hidden
					>
						{char}
					</span>
				),
			)}
		</span>
	);
}
