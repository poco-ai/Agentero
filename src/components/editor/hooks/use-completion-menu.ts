"use client";

import {
	type Dispatch,
	type MutableRefObject,
	type KeyboardEvent as ReactKeyboardEvent,
	type RefObject,
	type SetStateAction,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

export type CompletionMenuController = {
	handleKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => boolean;
};

/**
 * Keyboard and highlight behaviour shared by the `[[wikilink]]` and `/slash`
 * completion menus: which item is highlighted, keeping it scrolled into view,
 * and which keys the menu owns while open.
 *
 * Escape and the vertical arrows behave identically in both menus, so they are
 * handled here. Confirming an item differs (submit keys, focus hand-off, how
 * far the event must be stopped), so that is delegated to `onSubmitKey`.
 */
export function useCompletionMenu<T>({
	items,
	open,
	resetKey,
	onClose,
	controllerRef,
	onSubmitKey,
}: {
	items: readonly T[];
	/** Keys are ignored when the menu is not live. */
	open: boolean;
	/** Highlight returns to the first item whenever this changes. */
	resetKey: unknown;
	onClose: () => void;
	controllerRef: MutableRefObject<CompletionMenuController | null>;
	/**
	 * Handle a non-navigation key against the highlighted item. Return true when
	 * the key was consumed.
	 */
	onSubmitKey: (
		event: ReactKeyboardEvent<HTMLDivElement>,
		item: T | undefined,
	) => boolean;
}): {
	selectedIndex: number;
	/** Move the highlight from outside the keyboard path (hover, re-anchor). */
	setSelectedIndex: Dispatch<SetStateAction<number>>;
	listRef: RefObject<HTMLDivElement | null>;
} {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		void resetKey;
		setSelectedIndex(0);
	}, [resetKey]);

	// Scroll the listbox only. scrollIntoView would scroll the editor container,
	// whose onScrollCapture dismisses the popup.
	useEffect(() => {
		const list = listRef.current;
		if (!list || !items[selectedIndex]) return;
		const option = list.querySelector<HTMLElement>(
			'[role="option"][aria-selected="true"]',
		);
		if (!option) return;
		const listRect = list.getBoundingClientRect();
		const optionRect = option.getBoundingClientRect();
		if (optionRect.bottom > listRect.bottom) {
			list.scrollTop += optionRect.bottom - listRect.bottom;
		} else if (optionRect.top < listRect.top) {
			list.scrollTop -= listRect.top - optionRect.top;
		}
	}, [items, selectedIndex]);

	const openRef = useRef(open);
	openRef.current = open;
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const selectedIndexRef = useRef(selectedIndex);
	selectedIndexRef.current = selectedIndex;
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onSubmitKeyRef = useRef(onSubmitKey);
	onSubmitKeyRef.current = onSubmitKey;

	// Stable controller identity: re-binding on every highlight change used to
	// briefly null `controllerRef` in layout cleanup, and selection re-renders
	// could race with the next keydown.
	useLayoutEffect(() => {
		controllerRef.current = {
			handleKeyDown: (event) => {
				if (!openRef.current) return false;
				if (event.key === "Escape") {
					event.preventDefault();
					onCloseRef.current();
					return true;
				}
				// Always consume vertical arrows while open so the caret cannot leave
				// the trigger token (which would dismiss the popup). Cycle when there
				// are items; still swallow the key when empty or loading.
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					event.stopPropagation();
					const count = itemsRef.current.length;
					if (count) {
						const delta = event.key === "ArrowDown" ? 1 : -1;
						setSelectedIndex((index) => (index + delta + count) % count);
					}
					return true;
				}
				return onSubmitKeyRef.current(
					event,
					itemsRef.current[selectedIndexRef.current],
				);
			},
		};
		return () => {
			controllerRef.current = null;
		};
	}, [controllerRef]);

	return { selectedIndex, setSelectedIndex, listRef };
}
