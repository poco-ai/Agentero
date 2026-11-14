import type { PdfDocumentObject } from "@embedpdf/models";
import { renderPdfGlyphBatch, renderPdfRegionImageBlob } from "./region-crop";

// Scope to the open document; retain compressed data, never canvas/ImageBitmap.
// Live URLs remain owned and revoked by each visible crop.
const BYTE_LIMIT = 16 * 1024 * 1024;
const ENTRY_LIMIT = 128;
type Entry = { promise: Promise<Blob>; bytes: number };
const caches = new WeakMap<PdfDocumentObject, Map<string, Entry>>();
type CropOptions = Parameters<typeof renderPdfRegionImageBlob>[0];
type PendingCrop = {
	options: CropOptions;
	resolve: (blob: Blob) => void;
	reject: (error: unknown) => void;
};
const pending = new WeakMap<PdfDocumentObject, Map<string, PendingCrop[]>>();

function renderCrop(options: CropOptions): Promise<Blob> {
	if (!options.transparentBackground) return renderPdfRegionImageBlob(options);
	let groups = pending.get(options.document);
	if (!groups) {
		groups = new Map();
		pending.set(options.document, groups);
	}
	const key = JSON.stringify([options.pageIndex, options.scaleFactor]);
	let group = groups.get(key);
	if (!group) {
		group = [];
		groups.set(key, group);
		const crops = group;
		const batches = groups;
		// All IntersectionObserver callbacks in this frame can contribute. A
		// microtask would flush between separate observers and miss the batch.
		setTimeout(() => {
			batches.delete(key);
			void renderPdfGlyphBatch(crops.map((c) => c.options)).then(
				(blobs) => {
					for (const [i, crop] of crops.entries()) crop.resolve(blobs[i]);
				},
				(error) => {
					// A malformed bbox or an encoding failure must not hide its
					// neighbors. Retry independently; never cache a failed batch.
					for (const crop of crops) {
						if (crops.length === 1) crop.reject(error);
						else
							void renderPdfGlyphBatch([crop.options]).then(
								([blob]) => crop.resolve(blob),
								crop.reject,
							);
					}
				},
			);
		}, 0);
	}
	return new Promise((resolve, reject) =>
		group.push({ options, resolve, reject }),
	);
}

export function readerCropBlob(
	options: Parameters<typeof renderPdfRegionImageBlob>[0],
): Promise<Blob> {
	let cache = caches.get(options.document);
	if (!cache) {
		cache = new Map();
		caches.set(options.document, cache);
	}
	const key = JSON.stringify([
		options.pageIndex,
		options.region,
		options.maxEdgePx,
		options.scaleFactor,
		options.transparentBackground,
	]);
	const cached = cache.get(key);
	if (cached) {
		cache.delete(key);
		cache.set(key, cached);
		return cached.promise;
	}
	const entries = cache;
	const entry: Entry = { bytes: 0, promise: renderCrop(options) };
	entry.promise = entry.promise.then(
		(blob) => {
			entry.bytes = blob.size;
			let bytes = [...entries.values()].reduce(
				(sum, value) => sum + value.bytes,
				0,
			);
			for (const [oldKey, value] of entries) {
				if (bytes <= BYTE_LIMIT && entries.size <= ENTRY_LIMIT) break;
				if (!value.bytes) continue;
				entries.delete(oldKey);
				bytes -= value.bytes;
			}
			return blob;
		},
		(error) => {
			if (entries.get(key) === entry) entries.delete(key);
			throw error;
		},
	);
	entries.set(key, entry);
	return entry.promise;
}
