/**
 * Transient DOM anchors for selection tokens. They let "show in source"
 * resolve the live Range immediately; never persisted or sent to a prompt.
 */
export const annotationRanges = new Map<string, Range>();

/** Drop a removed token's anchor and any still-visible native highlight. */
export function releaseAnnotationAnchor(id: string): void {
	const anchor = annotationRanges.get(id);
	if (anchor) {
		const matches = (range: AbstractRange) =>
			range.startContainer === anchor.startContainer &&
			range.startOffset === anchor.startOffset &&
			range.endContainer === anchor.endContainer &&
			range.endOffset === anchor.endOffset;
		const selection =
			typeof window === "undefined" ? null : window.getSelection();
		if (
			selection &&
			Array.from({ length: selection.rangeCount }, (_, i) =>
				selection.getRangeAt(i),
			).some(matches)
		)
			selection.removeAllRanges();
		if (typeof CSS !== "undefined" && CSS.highlights) {
			for (const name of [
				"agentero-annotation-selection",
				"agentero-context-selection",
				"agentero-annotation-navigation",
			]) {
				const highlight = CSS.highlights.get(name);
				if (!highlight) continue;
				for (const range of highlight)
					if (matches(range)) highlight.delete(range);
				if (!highlight.size) CSS.highlights.delete(name);
			}
		}
	}
	annotationRanges.delete(id);
}
