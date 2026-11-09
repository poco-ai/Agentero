/**
 * Per-machine memory of "ignore the partial-translation hint" decisions.
 *
 * Keyed by paper, the translate cache identity (provider / languages / service
 * config) and a fingerprint of the still-untranslated blocks, so a new gap set
 * or a changed service asks again. Kept in localStorage like
 * `reading-position.ts`; `layout-translate.json` keeps its existing schema.
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import type { LayoutTranslateCacheKey } from "@/lib/pdf/layout/layout-translate";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

const DISMISSED_KEY = "agentero-pdf-layout-translate-partial-dismissed";
const MAX_DISMISSED = 50;

/** FNV-1a 32-bit fingerprint; only used for local UI identity, not security. */
function hashText(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/** Order-independent identity of the pending block ids. */
export function pendingLayoutTranslateFingerprint(
	items: readonly Pick<LayoutTranslateItem, "id">[],
): string {
	return hashText(
		items
			.map((item) => item.id)
			.sort()
			.join("\n"),
	);
}

/**
 * Dismissal identity for the current gap set, or null when nothing is pending.
 * Uses ids only so streaming progress (status / translated text) cannot change
 * the identity while the same blocks remain missing.
 */
export function translationPartialDismissalKey(input: {
	paperKey: string;
	cacheKey: LayoutTranslateCacheKey | null;
	pendingItems: readonly Pick<LayoutTranslateItem, "id">[];
}): string | null {
	const { paperKey, cacheKey, pendingItems } = input;
	if (!paperKey || !cacheKey || pendingItems.length === 0) return null;
	const cacheIdentity = [
		cacheKey.providerId,
		cacheKey.sourceLang,
		cacheKey.targetLang,
		cacheKey.serviceKey,
	].join("\u0001");
	return `${paperKey}\u0000${hashText(
		`${cacheIdentity}\u0002${pendingLayoutTranslateFingerprint(pendingItems)}`,
	)}`;
}

function readDismissedKeys(): string[] {
	const parsed = readJsonStorage<unknown>(DISMISSED_KEY, []);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((value): value is string => typeof value === "string");
}

/** True when the user already chose "ignore" for this exact pending set. */
export function isTranslationPartialDismissed(
	key: string | null | undefined,
): boolean {
	if (!key) return false;
	return readDismissedKeys().includes(key);
}

/** Remember "ignore" for this pending set; newest entries win under the cap. */
export function dismissTranslationPartial(
	key: string | null | undefined,
): void {
	if (!key) return;
	const keys = readDismissedKeys().filter((value) => value !== key);
	keys.push(key);
	writeJsonStorage(DISMISSED_KEY, keys.slice(-MAX_DISMISSED));
}

/** Drop one dismissal record (retranslate, or a completed gap set). */
export function clearTranslationPartialDismissal(
	key: string | null | undefined,
): void {
	if (!key) return;
	const keys = readDismissedKeys();
	const next = keys.filter((value) => value !== key);
	if (next.length !== keys.length) writeJsonStorage(DISMISSED_KEY, next);
}
