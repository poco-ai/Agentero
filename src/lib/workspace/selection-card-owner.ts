/** One visible translation per webview, shared by PDF and text surfaces. */
let dismiss: (() => void) | null = null;
export function claimSelectionTranslation(close: () => void): void {
	if (dismiss === close) return;
	const previous = dismiss;
	dismiss = close;
	previous?.();
}
export function releaseSelectionTranslation(close: () => void): void {
	if (dismiss === close) dismiss = null;
}
export function ownsSelectionTranslation(close: () => void): boolean {
	return dismiss === close;
}
