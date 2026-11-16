/** KaTeX keeps the original TeX source in this hidden annotation node. */
export const RENDERED_MATH_SELECTOR = ".katex";
const RENDERED_MATH_ANNOTATION = 'annotation[encoding="application/x-tex"]';

export type RenderedMathHit = {
	element: Element;
	tex: string;
};

export function renderedMathSource(node: Element): string | null {
	const tex = node.querySelector(RENDERED_MATH_ANNOTATION)?.textContent?.trim();
	return tex ? tex : null;
}

/** The rendered formula under a pointer target, scoped to a Markdown surface. */
export function renderedMathFromTarget(
	target: EventTarget | null,
	root: Element,
): RenderedMathHit | null {
	if (typeof Element === "undefined" || !(target instanceof Element)) {
		return null;
	}
	const element = target.closest(RENDERED_MATH_SELECTOR);
	if (!element || !root.contains(element)) return null;
	const tex = renderedMathSource(element);
	return tex ? { element, tex } : null;
}
