import { isKeyboardInput, keyboardModalOpen } from "@/lib/keyboard/ownership";

/** Widgets whose native keyboard behavior must win over PDF reading keys. */
export const PDF_KEYBOARD_EXCLUDED = [
	"[data-pdf-chrome]",
	"[role='dialog']",
	"[role='menu']",
	"[role='menuitem']",
	"[role='menuitemradio']",
	"[role='listbox']",
	"[role='option']",
	"[role='tree']",
	"[role='treeitem']",
	"[role='grid']",
	"[role='gridcell']",
	"[role='slider']",
	"[role='spinbutton']",
	"[role='combobox']",
	"[role='radiogroup']",
	"[role='tablist']",
].join(", ");

/** Decide whether a PDF surface owns a key event. */
export function ownsPdfKeyboard(args: {
	target: EventTarget | null;
	host: HTMLElement | null;
	active: boolean;
}): boolean {
	const { target, host, active } = args;
	if (
		!host ||
		isKeyboardInput(target) ||
		isKeyboardInput(host.ownerDocument.activeElement) ||
		keyboardModalOpen(host.ownerDocument)
	)
		return false;
	if (target instanceof Element && target.closest(PDF_KEYBOARD_EXCLUDED)) {
		return false;
	}
	if (host.matches(":hover")) return true;
	// An active Dockview panel cannot steal from the other hovered split.
	if (
		Array.from(host.ownerDocument.querySelectorAll("[data-pdf-viewport]")).some(
			(viewport) => !host.contains(viewport) && viewport.matches(":hover"),
		)
	)
		return false;
	if (!active) return false;
	const focused = host.ownerDocument.activeElement;
	return (
		!focused ||
		focused === host.ownerDocument.body ||
		focused === host.ownerDocument.documentElement ||
		host.contains(focused)
	);
}
