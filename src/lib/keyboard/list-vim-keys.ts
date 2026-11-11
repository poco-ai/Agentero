/**
 * j/k/h/l on list surfaces — open dropdowns and trees.
 *
 * Menus, selects and the file tree already implement the arrow keys. Re-dispatch
 * the equivalent arrow instead of reimplementing navigation, so vim keys inherit
 * skip-disabled, wrap-around, expand/collapse and Enter behavior from the owning
 * component.
 */

/** Popups that own arrow-key navigation; `closed` ones stay mounted briefly. */
const OPEN_POPUP =
	'[role="menu"]:not([data-state="closed"]), [role="listbox"]:not([data-state="closed"])';

/** j/k walk a vertical list; h/l are only meaningful in a tree. */
const MENU_ARROW: Record<string, "ArrowDown" | "ArrowUp"> = {
	j: "ArrowDown",
	k: "ArrowUp",
};
const TREE_ARROW: Record<
	string,
	"ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight"
> = {
	...MENU_ARROW,
	h: "ArrowLeft",
	l: "ArrowRight",
};

type ListVimKeyEvent = Pick<
	KeyboardEvent,
	"key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

function arrowKey(arrow: string): KeyboardEvent {
	return new KeyboardEvent("keydown", {
		key: arrow,
		code: arrow,
		bubbles: true,
		cancelable: true,
	});
}

function ownsPopupFocus(
	popup: HTMLElement,
	active: HTMLElement | null,
): boolean {
	if (!active) return false;
	if (popup.contains(active)) return true;
	if (!popup.id) return false;
	return (
		active.getAttribute("aria-controls") === popup.id ||
		active.getAttribute("aria-owns") === popup.id
	);
}

/** Returns true when the key was consumed by a menu, listbox or tree. */
export function forwardListVimKey(
	event: ListVimKeyEvent,
	doc: Document = document,
): boolean {
	if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
		return false;
	}
	const key = event.key.toLowerCase();
	const active =
		doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
	const popup = Array.from(doc.querySelectorAll<HTMLElement>(OPEN_POPUP)).at(
		-1,
	);
	if (
		popup &&
		popup.getClientRects().length > 0 &&
		ownsPopupFocus(popup, active)
	) {
		const arrow = MENU_ARROW[key];
		if (!arrow) return false;
		(active ?? popup).dispatchEvent(arrowKey(arrow));
		return true;
	}

	// File tree / outline: arrows move focus + selection and walk the hierarchy.
	const treeArrow = TREE_ARROW[key];
	if (treeArrow && active?.closest("[role='tree'] [role='treeitem']")) {
		active.dispatchEvent(arrowKey(treeArrow));
		return true;
	}
	return false;
}
