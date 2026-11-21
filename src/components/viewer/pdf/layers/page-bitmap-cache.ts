const DEFAULT_PAGE_BITMAP_LIMIT = 24;
const DEFAULT_PAGE_BITMAP_BYTES = 32 * 1024 * 1024;

export type PageBitmap = ReturnType<typeof createPageBitmap>;

export function createPageBitmap(blob: Blob) {
	let url: string | undefined;
	let users = 0;
	return {
		size: blob.size,
		retain() {
			url ??= URL.createObjectURL(blob);
			const source = url;
			users += 1;
			return {
				url: source,
				release() {
					if (--users !== 0) return;
					URL.revokeObjectURL(source);
					url = undefined;
				},
			};
		},
	};
}

type Entry = {
	scope: object;
	documentId: string;
	key: string;
	bitmap: PageBitmap;
};

type Slot = { entry: Entry; release: () => void };

/** LRU for reusable base coats. Mounted images keep an independent lease. */
export function createPageBitmapCache(
	limit = DEFAULT_PAGE_BITMAP_LIMIT,
	byteLimit = DEFAULT_PAGE_BITMAP_BYTES,
) {
	const slots = new Map<string, Slot>();
	const scopeIds = new WeakMap<object, number>();
	let nextScopeId = 0;
	let bytes = 0;

	function idFor(scope: object, documentId: string, pageIndex: number): string {
		let scopeId = scopeIds.get(scope);
		if (scopeId === undefined) {
			scopeId = ++nextScopeId;
			scopeIds.set(scope, scopeId);
		}
		return `${scopeId}:${documentId}:${pageIndex}`;
	}

	function remove(id: string, slot: Slot): void {
		slots.delete(id);
		bytes -= slot.entry.bitmap.size;
		slot.release();
	}

	return {
		get(scope: object, documentId: string, pageIndex: number) {
			const id = idFor(scope, documentId, pageIndex);
			const slot = slots.get(id);
			if (!slot) return undefined;
			slots.delete(id);
			slots.set(id, slot);
			return slot.entry;
		},
		store(entry: Entry, pageIndex: number): void {
			if (entry.bitmap.size > byteLimit) return;
			const id = idFor(entry.scope, entry.documentId, pageIndex);
			const { release } = entry.bitmap.retain();
			const previous = slots.get(id);
			if (previous) remove(id, previous);
			slots.set(id, { entry, release });
			bytes += entry.bitmap.size;
			for (const [oldId, oldest] of slots) {
				if (slots.size <= limit && bytes <= byteLimit) break;
				remove(oldId, oldest);
			}
		},
		clear(scope: object, documentId?: string): void {
			for (const [id, slot] of slots) {
				if (
					slot.entry.scope === scope &&
					(documentId === undefined || slot.entry.documentId === documentId)
				) {
					remove(id, slot);
				}
			}
		},
	};
}

export const pageBitmapCache = createPageBitmapCache();
