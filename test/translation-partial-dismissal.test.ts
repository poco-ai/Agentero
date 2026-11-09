import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutTranslateCacheKey } from "@/lib/pdf/layout/layout-translate";
import {
	clearTranslationPartialDismissal,
	dismissTranslationPartial,
	isTranslationPartialDismissed,
	pendingLayoutTranslateFingerprint,
	translationPartialDismissalKey,
} from "@/lib/pdf/translation-partial-dismissal";

class MemoryStorage
	implements Pick<Storage, "getItem" | "setItem" | "removeItem">
{
	private values = new Map<string, string>();
	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
	removeItem(key: string): void {
		this.values.delete(key);
	}
}

const cacheKey: LayoutTranslateCacheKey = {
	providerId: "googleapi",
	sourceLang: "auto",
	targetLang: "zh-CN",
	serviceKey: "googleapi",
};

function keyFor(
	pendingIds: string[],
	overrides: Partial<{
		paperKey: string;
		cacheKey: LayoutTranslateCacheKey;
	}> = {},
): string | null {
	return translationPartialDismissalKey({
		paperKey: overrides.paperKey ?? "/vault/papers/a",
		cacheKey: overrides.cacheKey ?? cacheKey,
		pendingItems: pendingIds.map((id) => ({ id })),
	});
}

describe("translationPartialDismissalKey", () => {
	beforeEach(() => {
		vi.stubGlobal("localStorage", new MemoryStorage());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is null when nothing is pending", () => {
		expect(keyFor([])).toBeNull();
		expect(pendingLayoutTranslateFingerprint([])).toBe(
			pendingLayoutTranslateFingerprint([]),
		);
	});

	it("ignores pending order but changes with paper, cache identity and gaps", () => {
		const base = keyFor(["a", "b", "c"]);
		expect(base).toBe(keyFor(["c", "a", "b"]));
		expect(base).not.toBe(keyFor(["a", "b"]));
		expect(base).not.toBe(keyFor(["a", "b", "c"], { paperKey: "/other" }));
		expect(base).not.toBe(
			keyFor(["a", "b", "c"], {
				cacheKey: { ...cacheKey, targetLang: "en" },
			}),
		);
		expect(base).not.toBe(
			keyFor(["a", "b", "c"], {
				cacheKey: { ...cacheKey, serviceKey: "googleapi:p1" },
			}),
		);
	});

	it("remembers and clears a dismissal", () => {
		const key = keyFor(["a"]);
		expect(key).not.toBeNull();
		if (!key) throw new Error("expected a dismissal key");
		expect(isTranslationPartialDismissed(key)).toBe(false);
		dismissTranslationPartial(key);
		expect(isTranslationPartialDismissed(key)).toBe(true);
		clearTranslationPartialDismissal(key);
		expect(isTranslationPartialDismissed(key)).toBe(false);
	});

	it("keeps different gap sets independent", () => {
		const first = keyFor(["a"]);
		const second = keyFor(["b"]);
		if (!first || !second) throw new Error("expected dismissal keys");
		dismissTranslationPartial(first);
		expect(isTranslationPartialDismissed(first)).toBe(true);
		expect(isTranslationPartialDismissed(second)).toBe(false);
	});
});
