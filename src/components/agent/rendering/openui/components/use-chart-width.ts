import { useEffect, useRef, useState } from "react";
import { MIN_CHART_WIDTH } from "@/lib/agent/openui/chart";

/** Matches the default chart geometry so SSR / first paint has a usable viewBox. */
const INITIAL_WIDTH = 640;

/**
 * Charts draw in a 1:1 user-unit viewBox: SVG labels keep their CSS size only
 * when the viewBox width tracks the rendered width. The Agent rail defaults to
 * 320 px, where a fixed 640 viewBox would shrink 10 px labels to ~5 px.
 */
export function useChartWidth() {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(INITIAL_WIDTH);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const apply = (next: number) => {
			const rounded = Math.round(next);
			if (rounded < MIN_CHART_WIDTH) return;
			setWidth((current) =>
				Math.abs(current - rounded) < 2 ? current : rounded,
			);
		};
		apply(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) apply(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return { ref, width };
}
