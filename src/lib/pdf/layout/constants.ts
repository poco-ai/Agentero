/**
 * Shared thresholds for the figures rail and PDF layout hit targets.
 */

/** Default confidence gate (0–1) for sidebar gallery + layout hit targets. */
export const LAYOUT_SIDEBAR_MIN_SCORE = 0.3;

/**
 * Smallest page-area fraction kept for the element selection view.
 * Lower than the figures-rail gate so a short header or caption still hits,
 * while speck-sized duplicate boxes stay out.
 */
export const LAYOUT_SELECT_MIN_AREA = 0.0004;

/**
 * Minimum on-screen region size (px) before the element chip shows a text preview.
 * The preview is a fixed-size label living inside a box that scales with zoom, so
 * on anything smaller it would spill past the region and cover its neighbours.
 */
export const LAYOUT_HINT_MIN_REGION_W_PX = 120;
export const LAYOUT_HINT_MIN_REGION_H_PX = 28;
