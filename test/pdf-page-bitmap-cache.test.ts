import { describe, expect, it } from "vitest";
import {
	createPageBitmap,
	createPageBitmapCache,
} from "@/components/viewer/pdf/layers/page-bitmap-cache";

const scope = {};
const documentId = "test";

function bitmap(size: number, key = "normal") {
	return {
		scope,
		documentId,
		key,
		bitmap: createPageBitmap(new Blob([new Uint8Array(size)])),
	};
}

describe("page bitmap cache", () => {
	it("keeps a recently read bitmap when newer pages exceed the limit", () => {
		const cache = createPageBitmapCache(2);
		const first = bitmap(1);
		cache.store(first, 0);
		cache.store(bitmap(1), 1);
		expect(cache.get(scope, documentId, 0)).toBe(first);
		cache.store(bitmap(1), 2);
		expect(cache.get(scope, documentId, 1)).toBeUndefined();
		expect(cache.get(scope, documentId, 0)).toBe(first);
		cache.clear(scope);
	});

	it("returns the replacement and accounts for only its size", () => {
		const cache = createPageBitmapCache(2, 4);
		const updated = bitmap(2, "zoomed");
		cache.store(bitmap(3), 0);
		cache.store(updated, 0);
		cache.store(bitmap(2), 1);
		expect(cache.get(scope, documentId, 0)).toBe(updated);
		expect(cache.get(scope, documentId, 1)).toBeDefined();
		cache.clear(scope);
	});
});
