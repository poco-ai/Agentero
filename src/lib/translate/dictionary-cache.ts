/** Word-lookup namespace of the shared translation result cache. */

import {
	clearResultCache,
	readResultCache,
	resultCacheKey,
	writeResultCache,
} from "./result-cache";

/** Hash the complete request contract; excerpts, settings and credentials never become filenames. */
export function dictionaryCacheKey(identity: unknown): Promise<string> {
	return resultCacheKey("dictionary", identity);
}

/** A damaged, old or unwritable cache is always a miss, never a lookup failure. */
export function readDictionaryCache(
	key: string,
	vault?: string | null,
): Promise<string | undefined> {
	return readResultCache("dictionary", key, vault);
}

/** Only completed successful results reach this function. */
export function writeDictionaryCache(
	key: string,
	result: string,
	vault?: string | null,
): Promise<void> {
	return writeResultCache("dictionary", key, result, vault);
}

/** Clear only this dictionary cache, preserving other Vault metadata and caches. */
export function clearDictionaryCache(vault?: string | null): Promise<void> {
	return clearResultCache("dictionary", vault);
}
