/** Numeric clamping shared across PDF geometry, layout and placement code. */

/** Clamp to the 0–1 range used by every normalized page rect. */
export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
