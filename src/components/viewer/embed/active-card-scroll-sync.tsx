import { useViewportElement } from "@embedpdf/plugin-viewport/react";
import { useEffect, useRef } from "react";

/**
 * Native viewport scroll → re-place floating selection cards.
 * Must render inside DockviewViewport (ViewportElementContext).
 */
export function ActiveCardScrollSync({
	active,
	onScroll,
}: {
	active: boolean;
	onScroll: () => void;
}) {
	const viewportRef = useViewportElement();
	const onScrollRef = useRef(onScroll);
	onScrollRef.current = onScroll;
	useEffect(() => {
		if (!active) return;
		const el = viewportRef?.current;
		if (!el) return;
		let raf: number | null = null;
		const handle = () => {
			if (raf != null) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				onScrollRef.current();
			});
		};
		el.addEventListener("scroll", handle, { passive: true });
		return () => {
			if (raf != null) cancelAnimationFrame(raf);
			el.removeEventListener("scroll", handle);
		};
	}, [active, viewportRef]);
	return null;
}
