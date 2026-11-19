import { useCallback, useEffect, useMemo, useState } from "react";
import { dirnameOf, normalizePath } from "@/lib/core/path";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import type { TreeDropEdge } from "../types";

const EMPTY_ORDER: readonly string[] = [];

function readOrder(key: string | null): readonly string[] {
	if (!key) return EMPTY_ORDER;
	const value = readJsonStorage<unknown>(key, null);
	return Array.isArray(value)
		? value.filter((path): path is string => typeof path === "string")
		: EMPTY_ORDER;
}

export function reorderPaperSiblings(
	siblings: readonly string[],
	paths: readonly string[],
	target: string,
	edge: TreeDropEdge,
): string[] | null {
	const dragged = new Set(paths);
	const moved = siblings.filter((path) => dragged.has(path));
	const next = siblings.filter((path) => !dragged.has(path));
	const index = next.indexOf(target);
	if (index < 0 || !moved.length || moved.length !== dragged.size) return null;
	next.splice(index + (edge === "after" ? 1 : 0), 0, ...moved);
	return next.some((path, i) => path !== siblings[i]) ? next : null;
}

export function usePaperTreeOrder(vaultPath: string | null) {
	const key = vaultPath
		? `agentero:paper-tree-order:${normalizePath(vaultPath)}`
		: null;
	const initial = useMemo(() => ({ order: readOrder(key) }), [key]);
	const [state, setState] = useState({ initial, order: initial.order });
	const order = state.initial === initial ? state.order : initial.order;
	const ranks = useMemo(
		() => new Map(order.map((path, index) => [path, index])),
		[order],
	);

	useEffect(() => {
		if (!key) return;
		const sync = (event: StorageEvent) => {
			if (event.key === key) setState({ initial, order: readOrder(key) });
		};
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, [initial, key]);

	const save = useCallback(
		(parent: string, siblings: readonly string[]) => {
			if (!key) return;
			const next = [
				...readOrder(key).filter((path) => dirnameOf(path) !== parent),
				...siblings,
			];
			writeJsonStorage(key, next);
			setState({ initial, order: next });
		},
		[initial, key],
	);
	return { ranks, save };
}
