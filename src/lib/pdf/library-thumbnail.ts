import { AsyncQueuer } from "@tanstack/react-pacer";
import { stat } from "@tauri-apps/plugin-fs";
import { LruCache } from "@/lib/core/lru-cache";
import { normalizeLocalPath } from "@/lib/core/path";
import { findLocalPdfPath, localFileToArrayBuffer } from "@/lib/paper/media";
import { withBackgroundPdfDocument } from "@/lib/pdf/background-engine";

const covers = new LruCache<string, Blob>(96);
const coverQueue = new AsyncQueuer((job: () => Promise<void>) => job(), {
	concurrency: 2,
});

async function renderCover(paperPath: string, signal: AbortSignal) {
	signal.throwIfAborted();
	const path = await findLocalPdfPath(paperPath);
	if (!path || signal.aborted) return null;
	const info = await stat(normalizeLocalPath(path));
	const key = JSON.stringify([path, info.size, info.mtime?.getTime()]);
	const cached = covers.get(key);
	if (cached) return cached;
	signal.throwIfAborted();
	const content = await localFileToArrayBuffer(path);
	if (!content) return null;
	const cover = await withBackgroundPdfDocument(
		{ id: `library-cover-${crypto.randomUUID()}`, content },
		signal,
		async (engine, document) => {
			const page = document.pages[0];
			if (!page) return null;
			const { width, height } = page.size;
			return engine
				.renderPage(document, page, {
					scaleFactor: Math.min(520 / width, 900 / Math.max(width, height)),
					dpr: 1,
					imageType: "image/jpeg",
					imageQuality: 0.85,
					withAnnotations: false,
					withForms: false,
				})
				.toPromise();
		},
	);
	if (cover) covers.set(key, cover);
	return cover;
}

export function loadLibraryThumbnail(paperPath: string, signal: AbortSignal) {
	return new Promise<Blob | null>((resolve) => {
		coverQueue.addItem(async () => {
			resolve(await renderCover(paperPath, signal).catch(() => null));
		});
	});
}
