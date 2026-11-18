/**
 * Selection-translate namespace of the shared result cache: re-selecting the
 * same passage shows its previous translation immediately instead of spending
 * another request.
 */

import {
	clearResultCache,
	readResultCache,
	resultCacheKey,
	writeResultCache,
} from "./result-cache";

/** Hash the complete request contract; the excerpt and settings never become filenames. */
export function selectionCacheKey(identity: unknown): Promise<string> {
	return resultCacheKey("selection", identity);
}

export function readSelectionCache(
	key: string,
	vault?: string | null,
): Promise<string | undefined> {
	return readResultCache("selection", key, vault);
}

export function writeSelectionCache(
	key: string,
	result: string,
	vault?: string | null,
): Promise<void> {
	return writeResultCache("selection", key, result, vault);
}

export function clearSelectionCache(vault?: string | null): Promise<void> {
	return clearResultCache("selection", vault);
}
