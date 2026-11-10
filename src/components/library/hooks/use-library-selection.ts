/**
 * Selection state for the papers library table.
 *
 * Holds selected row keys plus the range anchor, and exposes the intents the
 * table wires to pointer/keyboard gestures: toggle, Shift range, select all,
 * right-click preparation, and marquee snapshot/restore for Escape.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	pruneKeys,
	rangeKeys,
	sameKeys,
	toggleKey,
} from "@/components/library/library-selection";

/** Modifier keys of a row selection gesture. */
export type RowSelectMods = { shift?: boolean };

export type LibrarySelection = {
	/** Selected keys, always a subset of the visible row order. */
	keys: ReadonlySet<string>;
	count: number;
	/** Every visible row is selected (and there is at least one). */
	allSelected: boolean;
	/** Some — but not all — visible rows are selected. */
	someSelected: boolean;
	isSelected: (key: string) => boolean;
	/** Checkbox click / ⌘-click toggles; Shift extends from the last anchor. */
	selectRow: (key: string, mods?: RowSelectMods) => void;
	/** One marquee frame: replaces the selection unless `additive`. */
	applyDrag: (keys: Iterable<string>, additive: boolean) => void;
	selectAll: () => void;
	clear: () => void;
	/** Right-click: keep an existing multi-selection, else select just that row. */
	prepareContext: (key: string) => void;
	/** Remember the selection before a marquee drag (Escape restores it). */
	beginDrag: () => void;
	cancelDrag: () => void;
};

const EMPTY: ReadonlySet<string> = new Set();

export function useLibrarySelection(
	order: readonly string[],
): LibrarySelection {
	const [keys, setKeys] = useState<ReadonlySet<string>>(EMPTY);
	/** Range anchor — a ref: it never renders, only feeds range math. */
	const anchorRef = useRef<string | null>(null);
	const keysRef = useRef(keys);
	keysRef.current = keys;
	const orderRef = useRef(order);
	orderRef.current = order;
	const dragSnapshotRef = useRef<ReadonlySet<string> | null>(null);

	// A filter / scope change hides rows: drop them so a batch action can never
	// hit papers the user cannot see.
	useEffect(() => {
		setKeys((prev) => pruneKeys(prev, order));
	}, [order]);

	const selectRow = useCallback((key: string, mods: RowSelectMods = {}) => {
		if (mods.shift && anchorRef.current) {
			const anchor = anchorRef.current;
			setKeys((prev) => {
				const next = new Set(rangeKeys(orderRef.current, anchor, key));
				return sameKeys(prev, next) ? prev : next;
			});
			return;
		}
		anchorRef.current = key;
		setKeys((prev) => toggleKey(prev, key));
	}, []);

	const applyDrag = useCallback((next: Iterable<string>, additive: boolean) => {
		const incoming = new Set(next);
		setKeys((prev) => {
			const merged = additive ? new Set([...prev, ...incoming]) : incoming;
			return sameKeys(prev, merged) ? prev : merged;
		});
	}, []);

	const selectAll = useCallback(() => {
		const all = orderRef.current;
		anchorRef.current = all[0] ?? null;
		setKeys((prev) => {
			const next = new Set(all);
			return sameKeys(prev, next) ? prev : next;
		});
	}, []);

	const clear = useCallback(() => {
		anchorRef.current = null;
		setKeys((prev) => (prev.size === 0 ? prev : EMPTY));
	}, []);

	const prepareContext = useCallback((key: string) => {
		anchorRef.current = key;
		setKeys((prev) => (prev.has(key) ? prev : new Set<string>([key])));
	}, []);

	const beginDrag = useCallback(() => {
		dragSnapshotRef.current = keysRef.current;
	}, []);

	const cancelDrag = useCallback(() => {
		const snapshot = dragSnapshotRef.current;
		dragSnapshotRef.current = null;
		if (snapshot) setKeys(snapshot);
	}, []);

	const isSelected = useCallback((key: string) => keys.has(key), [keys]);
	const count = keys.size;
	const allSelected = count > 0 && count === order.length;
	const someSelected = count > 0 && !allSelected;

	return {
		keys,
		count,
		allSelected,
		someSelected,
		isSelected,
		selectRow,
		applyDrag,
		selectAll,
		clear,
		prepareContext,
		beginDrag,
		cancelDrag,
	};
}
