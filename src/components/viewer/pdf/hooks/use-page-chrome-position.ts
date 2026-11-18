import { type RefObject, useLayoutEffect, useState } from "react";
import { translateTabPlacement } from "@/lib/pdf/translate-tab";

/** Keep a screen-sized page control visible when the page corner scrolls away. */
export function usePageChromePosition(
	ref: RefObject<HTMLButtonElement | null>,
) {
	const [position, setPosition] = useState({ x: 0, y: 0, visible: false });
	useLayoutEffect(() => {
		const button = ref.current;
		const page = button?.offsetParent;
		const viewport = button?.closest("[data-pdf-viewport]");
		if (!button || !(page instanceof HTMLElement) || !viewport) return;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const pageBox = page.getBoundingClientRect();
			if (!page.offsetWidth || !page.offsetHeight) return;
			const scaleX = pageBox.width / page.offsetWidth;
			const scaleY = pageBox.height / page.offsetHeight;
			if (scaleX <= 0 || scaleY <= 0) return;
			const style = getComputedStyle(button);
			const placement = translateTabPlacement(
				pageBox,
				viewport.getBoundingClientRect(),
				{
					width: button.offsetWidth * scaleX,
					height: button.offsetHeight * scaleY,
				},
				{
					x: Number.parseFloat(style.left) * scaleX || 0,
					y: Number.parseFloat(style.top) * scaleY || 0,
				},
			);
			const next = {
				...placement,
				x: placement.x / scaleX,
				y: placement.y / scaleY,
			};
			setPosition((previous) =>
				previous.x === next.x &&
				previous.y === next.y &&
				previous.visible === next.visible
					? previous
					: next,
			);
		};
		const schedule = () => {
			frame ||= requestAnimationFrame(measure);
		};
		measure();
		const observer = new ResizeObserver(schedule);
		observer.observe(page);
		observer.observe(viewport);
		observer.observe(button);
		// The scroller is nested inside the viewport; scroll does not bubble.
		viewport.addEventListener("scroll", schedule, true);
		window.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			viewport.removeEventListener("scroll", schedule, true);
			window.removeEventListener("resize", schedule);
		};
	}, [ref]);
	return position;
}
