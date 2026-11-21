/**
 * Visual crop / selection frame over PDF paper. Position and shape only: the
 * ink lives in index.css (`.pdf-visual-region-frame`), where it follows the
 * paper tone instead of the UI theme — a dark appearance theme would otherwise
 * paint a near-white frame that disappears on white paper.
 */
export const PDF_VISUAL_REGION_FRAME_CLASS =
	"pdf-visual-region-frame pointer-events-none absolute box-border rounded-[2px]";
