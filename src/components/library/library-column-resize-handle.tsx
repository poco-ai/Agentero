import { useRef } from "react";
import { clampColumnWidth } from "@/components/library/library-column-widths";

export function LibraryColumnResizeHandle({
	label,
	onResize,
}: {
	label: string;
	onResize: (width: number | null, commit: boolean) => void;
}) {
	const drag = useRef<{
		pointer: number;
		x: number;
		width: number;
		rem: number;
		current: number;
	} | null>(null);
	const measure = (el: HTMLElement) => {
		const rem = Number.parseFloat(
			getComputedStyle(el.ownerDocument.documentElement).fontSize,
		);
		return {
			rem,
			width: (el.closest("th")?.getBoundingClientRect().width ?? 80) / rem,
		};
	};
	return (
		<button
			type="button"
			data-library-resize
			aria-label={label}
			title={label}
			className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none border-r border-border/50 hover:border-primary hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			onClick={(e) => e.stopPropagation()}
			onDragStart={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				e.currentTarget.focus();
				const { width, rem } = measure(e.currentTarget);
				drag.current = {
					pointer: e.pointerId,
					x: e.clientX,
					width,
					rem,
					current: width,
				};
				e.currentTarget.setPointerCapture(e.pointerId);
			}}
			onPointerMove={(e) => {
				const state = drag.current;
				if (!state || state.pointer !== e.pointerId) return;
				state.current = clampColumnWidth(
					state.width + (e.clientX - state.x) / state.rem,
				);
				onResize(state.current, false);
			}}
			onPointerUp={(e) => {
				const state = drag.current;
				if (!state || state.pointer !== e.pointerId) return;
				state.current = clampColumnWidth(
					state.width + (e.clientX - state.x) / state.rem,
				);
				drag.current = null;
				e.currentTarget.releasePointerCapture(e.pointerId);
				if (state.current !== state.width) onResize(state.current, true);
				else onResize(null, false);
			}}
			onLostPointerCapture={() => {
				if (drag.current) {
					drag.current = null;
					onResize(null, false);
				}
			}}
			onPointerCancel={() => {
				drag.current = null;
				onResize(null, false);
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && drag.current) {
					const pointer = drag.current.pointer;
					drag.current = null;
					e.currentTarget.releasePointerCapture(pointer);
					onResize(null, false);
					e.preventDefault();
					e.stopPropagation();
				} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
					e.preventDefault();
					e.stopPropagation();
					const { width } = measure(e.currentTarget);
					onResize(
						clampColumnWidth(width + (e.key === "ArrowRight" ? 1 : -1)),
						true,
					);
				}
			}}
		/>
	);
}
