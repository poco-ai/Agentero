/** Layout presets selectable from the title-bar menu (no free-form mode). */
export type LayoutPresetMode = "agent" | "notes" | "reading";

/** Fraction of the source + Agent area occupied by the Agent rail. */
export const LAYOUT_MODE_RIGHT_RATIOS: Record<LayoutPresetMode, number> = {
	agent: 1 / 3,
	notes: 0,
	reading: 0,
};

/** Whether the preset should collapse the right Agent/annotations sidebar. */
export const LAYOUT_MODE_RIGHT_COLLAPSED: Record<LayoutPresetMode, boolean> = {
	agent: false,
	notes: true,
	reading: true,
};

export function layoutModeRightRatio(mode: LayoutPresetMode): number {
	return LAYOUT_MODE_RIGHT_RATIOS[mode];
}

export function layoutModeRightCollapsed(mode: LayoutPresetMode): boolean {
	return LAYOUT_MODE_RIGHT_COLLAPSED[mode];
}
