import type { SVGProps } from "react";

/**
 * Layout-element selection glyph — a wide page frame with a pointer, cut where
 * the cursor overlaps it. No upstream set carries this exact shape (the closest
 * lucide square is square), so the path lives here instead of a dependency.
 */
export function LayoutElementSelectIcon({
	className,
	...props
}: SVGProps<SVGSVGElement>) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
			{...props}
		>
			<title>Layout element select</title>
			{/* Frame: top, left and the two edges the pointer interrupts. */}
			<path d="M19.8 12.3V5.55a2 2 0 0 0-2-2H3.6a2 2 0 0 0-2 2V13.9a2 2 0 0 0 2 2H9.7" />
			<path d="M12.65 8.75 20.45 16.55l-4.55.35v3.2z" />
		</svg>
	);
}
