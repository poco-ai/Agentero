export type HintTarget = {
	element: HTMLElement;
	rect: DOMRect;
	priority: number;
	source: "explicit" | "generic";
};

const EXPLICIT = "[data-hint]";
const GENERIC = [
	"button:not([disabled])",
	"[role='tab']",
	"[role='button']",
	"[role='treeitem']",
	"a[href]",
].join(",");
const INTERACTIVE =
	"button, [role='tab'], [role='button'], [role='treeitem'], a[href]";
const MAX_HINT_TARGETS = 60;

function visible(
	element: HTMLElement,
	viewport: { width: number; height: number },
) {
	if (
		element.closest(
			"[inert], [hidden], [aria-hidden='true'], [data-hint-ignore], [contenteditable]:not([contenteditable='false']), [data-pdf-content]",
		)
	)
		return false;
	if (
		element.matches(
			"[disabled], [aria-disabled='true'], [inert], [hidden], [data-hint-ignore], input, textarea, select, [contenteditable], canvas, [data-pdf-content]",
		)
	) {
		return false;
	}
	const style = element.ownerDocument.defaultView?.getComputedStyle(element);
	if (
		!style ||
		style.display === "none" ||
		style.visibility === "hidden" ||
		style.opacity === "0"
	) {
		return false;
	}
	const rect = element.getBoundingClientRect();
	const doc = element.ownerDocument;
	const hit = doc.elementFromPoint?.(
		(Math.max(0, rect.left) + Math.min(viewport.width, rect.right)) / 2,
		(Math.max(0, rect.top) + Math.min(viewport.height, rect.bottom)) / 2,
	);
	if (hit && !element.contains(hit)) return false;
	return (
		rect.width >= 8 &&
		rect.height >= 8 &&
		rect.bottom > 0 &&
		rect.right > 0 &&
		rect.top < viewport.height &&
		rect.left < viewport.width
	);
}

function dedupe(element: HTMLElement): HTMLElement | null {
	const parent = element.closest(INTERACTIVE);
	return parent instanceof HTMLElement && parent !== element ? parent : element;
}

/** Collect frozen, visible targets from a session's scope root. */
export function collectHintTargets(
	root: ParentNode,
	viewport = { width: window.innerWidth, height: window.innerHeight },
): HintTarget[] {
	const candidates = [
		...Array.from(root.querySelectorAll<HTMLElement>(EXPLICIT)).map(
			(element) => ({
				element,
				source: "explicit" as const,
			}),
		),
		...Array.from(root.querySelectorAll<HTMLElement>(GENERIC)).map(
			(element) => ({
				element,
				source: "generic" as const,
			}),
		),
	];
	const seen = new Set<HTMLElement>();
	return candidates
		.map(({ element, source }) => {
			const target = dedupe(element);
			if (!target || seen.has(target) || !visible(target, viewport))
				return null;
			seen.add(target);
			const rect = target.getBoundingClientRect();
			const priority =
				source === "explicit"
					? Number(target.dataset.hintPriority ?? 2) || 2
					: 3;
			return { element: target, rect, priority, source };
		})
		.filter((target): target is HintTarget => target !== null)
		.sort(
			(a, b) =>
				a.priority - b.priority ||
				a.rect.top - b.rect.top ||
				a.rect.left - b.rect.left,
		)
		.slice(0, MAX_HINT_TARGETS);
}
