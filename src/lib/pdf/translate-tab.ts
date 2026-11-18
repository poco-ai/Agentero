/** Position page chrome in screen coordinates, independently of PDF zoom. */
type Box = { left: number; top: number; right: number; bottom: number };

export function translateTabPlacement(
	page: Box,
	viewport: Box,
	button: { width: number; height: number },
	margin: { x: number; y: number },
): { x: number; y: number; visible: boolean } {
	const left = Math.max(page.left, viewport.left) + margin.x;
	const top = Math.max(page.top, viewport.top) + margin.y;
	const right = Math.min(page.right, viewport.right) - margin.x;
	const bottom = Math.min(page.bottom, viewport.bottom) - margin.y;
	return {
		x: left - page.left - margin.x,
		y: top - page.top - margin.y,
		visible: right - left >= button.width && bottom - top >= button.height,
	};
}
