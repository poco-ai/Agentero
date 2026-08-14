import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/core/utils";

/**
 * MagicUI Animated Circular Progress Bar
 * https://magicui.design/docs/components/animated-circular-progress-bar
 *
 * Extended with optional `children` to render custom centre content instead
 * of the raw percentage.
 */
interface AnimatedCircularProgressBarProps {
	max?: number;
	min?: number;
	value: number;
	gaugePrimaryColor: string;
	gaugeSecondaryColor: string;
	className?: string;
	children?: ReactNode;
}

export function AnimatedCircularProgressBar({
	max = 100,
	min = 0,
	value = 0,
	gaugePrimaryColor,
	gaugeSecondaryColor,
	className,
	children,
}: AnimatedCircularProgressBarProps) {
	const circumference = 2 * Math.PI * 45;
	const percentPx = circumference / 100;
	const currentPercent = Math.round(((value - min) / (max - min)) * 100);

	return (
		<div
			className={cn("relative size-40 font-semibold text-2xl", className)}
			style={
				{
					"--circle-size": "100px",
					"--circumference": circumference,
					"--percent-to-px": `${percentPx}px`,
					"--gap-percent": "5",
					"--offset-factor": "0",
					"--transition-length": "1s",
					"--transition-step": "200ms",
					"--delay": "0s",
					"--percent-to-deg": "3.6deg",
					transform: "translateZ(0)",
				} as CSSProperties
			}
		>
			<svg
				fill="none"
				className="size-full"
				strokeWidth="2"
				viewBox="0 0 100 100"
				aria-hidden="true"
			>
				{currentPercent <= 90 && currentPercent >= 0 && (
					<circle
						cx="50"
						cy="50"
						r="45"
						strokeWidth="10"
						strokeDashoffset="0"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="opacity-100"
						style={
							{
								stroke: gaugeSecondaryColor,
								"--stroke-percent": 90 - currentPercent,
								"--offset-factor-secondary": "calc(1 - var(--offset-factor))",
								strokeDasharray:
									"calc(var(--stroke-percent) * var(--percent-to-px)) var(--circumference)",
								transform:
									"rotate(calc(1turn - 90deg - (var(--gap-percent) * var(--percent-to-deg) * var(--offset-factor-secondary)))) scaleY(-1)",
								transition: "all var(--transition-length) ease var(--delay)",
								transformOrigin:
									"calc(var(--circle-size) / 2) calc(var(--circle-size) / 2)",
							} as CSSProperties
						}
					/>
				)}
				<circle
					cx="50"
					cy="50"
					r="45"
					strokeWidth="10"
					strokeDashoffset="0"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="opacity-100"
					style={
						{
							stroke: gaugePrimaryColor,
							"--stroke-percent": currentPercent,
							strokeDasharray:
								"calc(var(--stroke-percent) * var(--percent-to-px)) var(--circumference)",
							transition:
								"var(--transition-length) ease var(--delay),stroke var(--transition-length) ease var(--delay)",
							transitionProperty: "stroke-dasharray,transform",
							transform:
								"rotate(calc(-90deg + var(--gap-percent) * var(--offset-factor) * var(--percent-to-deg)))",
							transformOrigin:
								"calc(var(--circle-size) / 2) calc(var(--circle-size) / 2)",
						} as CSSProperties
					}
				/>
			</svg>
			<span
				data-current-value={currentPercent}
				className="absolute inset-0 m-auto size-fit fade-in animate-in delay-(--delay) duration-(--transition-length) ease-linear"
			>
				{children ?? currentPercent}
			</span>
		</div>
	);
}
