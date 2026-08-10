import { useRef, useState } from "react";

import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { normalizedRegionFromPoints } from "@/lib/pdf/region";

type Point = { x: number; y: number };

function normalizedPoint(
	element: HTMLElement,
	clientX: number,
	clientY: number,
): Point {
	const bounds = element.getBoundingClientRect();
	return {
		x: (clientX - bounds.left) / Math.max(1, bounds.width),
		y: (clientY - bounds.top) / Math.max(1, bounds.height),
	};
}

export function PdfRegionSelectLayer({
	active,
	label,
	onSelect,
}: {
	active: boolean;
	label: string;
	onSelect: (region: PdfAskNormalizedRect) => void;
}) {
	const startRef = useRef<Point | null>(null);
	const [draft, setDraft] = useState<PdfAskNormalizedRect | null>(null);

	if (!active) return null;

	return (
		<div
			role="application"
			aria-label={label}
			// Above page content; capture all pointers so EmbedPDF cannot start a text selection.
			className="absolute inset-0 z-20 cursor-crosshair touch-none select-none"
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				const point = normalizedPoint(
					event.currentTarget,
					event.clientX,
					event.clientY,
				);
				startRef.current = point;
				setDraft({ x: point.x, y: point.y, w: 0, h: 0 });
			}}
			onPointerMove={(event) => {
				const start = startRef.current;
				if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) {
					return;
				}
				const current = normalizedPoint(
					event.currentTarget,
					event.clientX,
					event.clientY,
				);
				setDraft(normalizedRegionFromPoints(start, current));
			}}
			onPointerUp={(event) => {
				const start = startRef.current;
				startRef.current = null;
				if (!start) return;
				const current = normalizedPoint(
					event.currentTarget,
					event.clientX,
					event.clientY,
				);
				const selected = normalizedRegionFromPoints(start, current);
				setDraft(null);
				if (event.currentTarget.hasPointerCapture(event.pointerId)) {
					event.currentTarget.releasePointerCapture(event.pointerId);
				}
				if (selected) onSelect(selected);
			}}
			onPointerCancel={(event) => {
				startRef.current = null;
				setDraft(null);
				if (event.currentTarget.hasPointerCapture(event.pointerId)) {
					event.currentTarget.releasePointerCapture(event.pointerId);
				}
			}}
		>
			{draft ? (
				<div
					className="pointer-events-none absolute rounded border border-primary bg-primary/10 shadow-sm"
					style={{
						left: `${draft.x * 100}%`,
						top: `${draft.y * 100}%`,
						width: `${draft.w * 100}%`,
						height: `${draft.h * 100}%`,
					}}
				/>
			) : null}
		</div>
	);
}
