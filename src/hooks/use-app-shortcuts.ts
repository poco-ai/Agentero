import { useEffect, useRef } from "react";
import { useNativeSelectAllGuard } from "@/hooks/use-native-select-all-guard";
import {
	resolveShortcutId,
	type ShortcutId,
	shortcutBelongsToTextField,
} from "@/lib/shell/shortcuts";

/** One handler per global keyboard shortcut. */
export type ShortcutHandlers = Record<ShortcutId, () => void>;

/**
 * Shortcuts that act on the vault file tree and make no sense anywhere else.
 * They fire only while the tree is the surface the user last touched, so the
 * keystroke can fall through to native cut/paste on other surfaces.
 */
const TREE_SURFACE_SHORTCUTS: ReadonlySet<ShortcutId> = new Set([
	"deleteTreeItem",
	"collapseTreeCurrent",
	"collapseTreeDefault",
	"cutTreeItem",
	"pasteTreeItem",
]);

/**
 * Bind the global keyboard shortcuts once and dispatch each to its handler.
 * Handlers are read from a ref so the listener never needs to re-bind.
 *
 * @param modalOverlayOpen - a modal app overlay/sheet is open (settings, dialogs, palette…).
 *   Gates `whenSettingsOpen` / `whenSettingsClosed` shortcut rules. Docked, non-modal
 *   surfaces such as the Agent ask-user form do not gate shortcuts.
 */
export function useAppShortcuts(
	modalOverlayOpen: boolean,
	handlers: ShortcutHandlers,
): void {
	useNativeSelectAllGuard();

	const modalOverlayOpenRef = useRef(modalOverlayOpen);
	modalOverlayOpenRef.current = modalOverlayOpen;
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	// Whether the vault file tree was the surface the user last interacted
	// with. Its clipboard shortcuts (⌘X / ⌘V) may only claim the keystroke on
	// its own surface: everywhere else the event must fall through so the
	// platform emits the native cut/paste — the Excalidraw canvas only pastes
	// clipboard images from a real `paste` event, and preventing the keydown
	// suppresses it. WebKit does not focus <button> rows on click, so the
	// keydown target / activeElement is unreliable; track pointer + focus
	// instead.
	const treeSurfaceActiveRef = useRef(false);
	useEffect(() => {
		const withinTree = (target: EventTarget | null) =>
			target instanceof Element && target.closest("[data-file-tree]") != null;
		const onPointerDown = (event: PointerEvent) => {
			treeSurfaceActiveRef.current = withinTree(event.target);
		};
		const onFocusIn = (event: FocusEvent) => {
			treeSurfaceActiveRef.current = withinTree(event.target);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("focusin", onFocusIn, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("focusin", onFocusIn, true);
		};
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (document.querySelector("[data-shortcut-recording]")) return;
			if (
				event.target instanceof Element &&
				event.target.closest("[data-shortcut-search]")
			) {
				return;
			}
			const id = resolveShortcutId(event, {
				settingsOpen: modalOverlayOpenRef.current,
			});
			if (!id) return;

			// Text fields keep their editor-native combos — ⌘⌫ delete-to-line,
			// ⌘← / ⇧⌘← line jumps, ⌘X/⌘V native cut/paste, ⌥A composed chars,
			// ⌘B bold. The shared helper owns that id/target decision.
			if (shortcutBelongsToTextField(id, event)) return;

			// File-tree shortcuts only apply on the tree's own surface. Elsewhere
			// the event must reach the platform so the focused viewer still gets
			// native cut/paste — Excalidraw pastes clipboard images only from a
			// real `paste` event, and preventDefault on the keydown suppresses it.
			if (TREE_SURFACE_SHORTCUTS.has(id) && !treeSurfaceActiveRef.current) {
				return;
			}

			event.preventDefault();
			if (id === "toggleMarkdownSource") {
				event.stopPropagation();
				if (event.repeat) return;
			}
			handlersRef.current[id]();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);
}
