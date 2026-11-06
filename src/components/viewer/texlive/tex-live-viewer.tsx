import type {
	PdfDocumentObject,
	PdfEngine,
	PdfPageObject,
} from "@embedpdf/models";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Loader2, RefreshCw } from "lucide-react";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePdfEngineContext } from "@/components/viewer/pdf/engine-provider";
import type {
	CompileStatus,
	Convergence,
	DisplayList,
	LayoutUpdateEvent,
	PageUpdate,
	ParagraphUpdateEvent,
	Placement,
	RtexEvent,
	Versions,
} from "@/components/viewer/texlive/protocol";
import { SP_PER_BP } from "@/components/viewer/texlive/protocol";
import {
	cachedPictureMoves,
	PreviewModel,
	type Rect,
} from "@/components/viewer/texlive/render/model";
import {
	FontStore,
	ImageStore,
	inexactReason,
	type Mat,
	Painter,
} from "@/components/viewer/texlive/render/render";
import { ResourceLoader } from "@/components/viewer/texlive/render/resources";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { cn } from "@/lib/core/utils";
import {
	startTexLiveSession,
	stopTexLiveSession,
	type TexLiveSession,
} from "@/lib/tex-live/session";

import {
	type TexLiveStatus,
	useTexLiveStatusStore,
} from "@/lib/tex-live/status";

const PAGE_GAP = 16;
const A4_WIDTH_SP = 597.5 * SP_PER_BP;
const A4_HEIGHT_SP = 845 * SP_PER_BP;

type RtexEventPayload = { sessionId: string; event: RtexEvent };

type CacheEntry = {
	pages: Map<number, PageUpdate>;
	pagesTotal: number;
	placements: Placement[];
	pdfFallback: string | null;
	convergence: Convergence;
	compile: CompileStatus;
	versions: Versions;
	passes: number;
	wallMs: number;
};

/** Last full layout per session. A remounted pane (StrictMode / tab switch)
 * replays every page instead of waiting for a pass whose `pages_changed`
 * would be empty for an already-installed layout. */
const layoutCaches = new Map<string, CacheEntry>();

function cacheLayout(sessionId: string, layout: LayoutUpdateEvent): void {
	const previous = layoutCaches.get(sessionId);
	const pages = previous?.pages ?? new Map<number, PageUpdate>();
	for (const page of layout.pages_changed) pages.set(page.page, page);
	for (const page of [...pages.keys()]) {
		if (page > layout.pages_total) pages.delete(page);
	}
	layoutCaches.set(sessionId, {
		pages,
		pagesTotal: layout.pages_total,
		placements: layout.placements,
		pdfFallback: layout.pdf_fallback,
		convergence: layout.convergence,
		compile: layout.compile,
		versions: layout.versions,
		passes: layout.passes,
		wallMs: layout.wall_ms,
	});
}

function cachedLayout(sessionId: string): LayoutUpdateEvent | null {
	const entry = layoutCaches.get(sessionId);
	if (!entry || entry.pages.size === 0) return null;
	return {
		event: "LayoutUpdate",
		versions: entry.versions,
		compile: entry.compile,
		convergence: entry.convergence,
		passes: entry.passes,
		pages_changed: [...entry.pages.values()],
		pages_total: entry.pagesTotal,
		placements: entry.placements,
		eligible_paragraphs: [],
		pdf_fallback: entry.pdfFallback,
		wall_ms: entry.wallMs,
	};
}

function taskToPromise<T>(task: {
	wait: (ok: (value: T) => void, error: (error: unknown) => void) => void;
}): Promise<T> {
	return new Promise((resolve, reject) => task.wait(resolve, reject));
}

function deviceRect(base: Mat, rect: Rect): [number, number, number, number] {
	const x = Math.round(rect.x * base[0] + base[4]);
	const y = Math.round(rect.y * base[3] + base[5]);
	return [
		x,
		y,
		Math.max(0, Math.round((rect.x + rect.w) * base[0] + base[4]) - x),
		Math.max(0, Math.round((rect.y + rect.h) * base[3] + base[5]) - y),
	];
}

function grabRect(
	ctx: CanvasRenderingContext2D,
	base: Mat,
	rect: Rect,
): ImageData | undefined {
	const [x, y, w, h] = deviceRect(base, rect);
	if (
		w < 1 ||
		h < 1 ||
		x >= ctx.canvas.width ||
		y >= ctx.canvas.height ||
		x + w <= 0 ||
		y + h <= 0
	) {
		return undefined;
	}
	return ctx.getImageData(x, y, w, h);
}

function putRect(
	ctx: CanvasRenderingContext2D,
	base: Mat,
	image: ImageData,
	rect: Rect,
): void {
	const [x, y] = deviceRect(base, rect);
	ctx.putImageData(image, x, y);
}

/** Rects covering each overlay row and the gap above it (sp). */
function rowBands(
	rows: {
		line: { x: number; y: number; w: number; h: number; d: number };
		dx: number;
		dy: number;
	}[],
): [number, number, number, number][] {
	const out: [number, number, number, number][] = [];
	const pt = 65536;
	let previousBottom: number | undefined;
	let previousBaseline = Number.NEGATIVE_INFINITY;
	for (const { line, dx, dy } of rows) {
		const baseline = line.y + dy;
		const ownTop = baseline - line.h - pt;
		const top =
			previousBottom !== undefined &&
			baseline > previousBaseline &&
			baseline - previousBaseline < 4 * (line.h + line.d + 2 * pt)
				? Math.min(ownTop, previousBottom)
				: ownTop;
		const bottom = baseline + Math.max(line.d, 3 * pt);
		out.push([line.x + dx - pt, top, line.x + dx + line.w + pt, bottom]);
		previousBottom = bottom;
		previousBaseline = baseline;
	}
	return out;
}

export interface TexLiveViewerProps {
	/** Root .tex file of the project. */
	rootPath: string;
	vaultPath: string | null;
	active?: boolean;
	className?: string;
}

/**
 * Canvas live preview for realtime-tex. The Rust host owns the session; this
 * component forwards its events into a `PreviewModel` and paints display lists.
 * Exact pages are drawn from glyph outlines; pages with material a display
 * list cannot describe fall back to the layout PDF via the shared PDFium
 * engine (TikZ, RTL, rotated pages).
 */
export function TexLiveViewer({
	rootPath,
	vaultPath,
	active = true,
	className,
}: TexLiveViewerProps) {
	const { t } = useTranslation("sidebar");
	const { engine } = usePdfEngineContext();
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const pagesRef = useRef<HTMLDivElement | null>(null);
	const pageElsRef = useRef(new Map<number, HTMLDivElement>());
	const modelRef = useRef(new PreviewModel());
	const fontsRef = useRef(new FontStore());
	const imagesRef = useRef<ImageStore | null>(null);
	const engineRef = useRef<PdfEngine | null>(engine);
	const pdfDocRef = useRef<PdfDocumentObject | null>(null);
	const pdfPathRef = useRef<string | null>(null);
	const pendingPdfPathRef = useRef<string | null>(null);
	const pdfSerialRef = useRef(0);
	const sessionRef = useRef<TexLiveSession | null>(null);
	const resourcesRef = useRef<ResourceLoader | null>(null);
	const dirtyRef = useRef(new Set<number>());
	const visibleRef = useRef(new Set<number>());
	const renderTokenRef = useRef(new Map<number, number>());
	const renderScheduledRef = useRef(false);
	const observerRef = useRef<IntersectionObserver | null>(null);
	const [pageCount, setPageCount] = useState(0);
	const [status, setStatus] = useState<TexLiveStatus>("starting");
	const statusOwner = useRef(Symbol("tex-live-viewer")).current;
	const [error, setError] = useState<string | null>(null);
	const [retryKey, setRetryKey] = useState(0);

	engineRef.current = engine;

	// ---------------------------------------------------------------------
	// PDF fallback / images

	const openPdfDocument = useCallback(
		async (data: Uint8Array, id: string): Promise<PdfDocumentObject> => {
			const pdf = engineRef.current;
			if (!pdf) throw new Error("PDF engine is not ready");
			const buffer = data.buffer.slice(
				data.byteOffset,
				data.byteOffset + data.byteLength,
			) as ArrayBuffer;
			return taskToPromise(pdf.openDocumentBuffer({ id, content: buffer }));
		},
		[],
	);

	const rasterizePdfImage = useCallback(
		async (data: Uint8Array, page: number): Promise<CanvasImageSource> => {
			const doc = await openPdfDocument(data, `rtex-img-${Date.now()}`);
			try {
				const pdfPage =
					doc.pages[Math.max(0, Math.min(page - 1, doc.pageCount - 1))];
				if (!pdfPage) throw new Error("PDF image page is unavailable");
				const longest = Math.max(pdfPage.size.width, pdfPage.size.height, 1);
				const scaleFactor = Math.min(6, 1800 / longest);
				const pdf = engineRef.current;
				if (!pdf) throw new Error("PDF engine is not ready");
				const blob = await taskToPromise(
					pdf.renderPage(doc, pdfPage, {
						scaleFactor,
						imageType: "image/png",
						withAnnotations: false,
						withForms: false,
					}),
				);
				return await createImageBitmap(blob);
			} finally {
				const pdf = engineRef.current;
				if (pdf)
					void taskToPromise(pdf.closeDocument(doc)).catch(() => undefined);
			}
		},
		[openPdfDocument],
	);

	if (!imagesRef.current) {
		imagesRef.current = new ImageStore(rasterizePdfImage);
	}

	// These refs break the render -> schedule -> render cycle without
	// re-creating the callbacks on every render.
	const scheduleRenderRef = useRef<() => void>(() => undefined);
	const renderPageRef = useRef<(page: number) => void>(() => undefined);

	const markDirty = useCallback((pages: Iterable<number>) => {
		for (const page of pages) {
			if (page >= 1 && page <= modelRef.current.pagesTotal) {
				dirtyRef.current.add(page);
			}
		}
		scheduleRenderRef.current();
	}, []);

	// ---------------------------------------------------------------------
	// Geometry

	const maxPageWidthSp = useCallback(() => {
		let width = 0;
		for (const page of modelRef.current.pages.values()) {
			width = Math.max(width, page.dl.page_width ?? 0);
		}
		return width || A4_WIDTH_SP;
	}, []);

	const cssScale = useCallback(() => {
		const viewport = viewportRef.current;
		const available = Math.max(
			120,
			(viewport?.clientWidth ?? 800) - 2 * PAGE_GAP,
		);
		return available / maxPageWidthSp();
	}, [maxPageWidthSp]);

	const pageSizeSp = useCallback((page: number): [number, number] => {
		const update =
			modelRef.current.pages.get(page) ??
			modelRef.current.pages.get(1) ??
			[...modelRef.current.pages.values()][0];
		return [
			update?.dl.page_width ?? A4_WIDTH_SP,
			update?.dl.page_height ?? A4_HEIGHT_SP,
		];
	}, []);

	const layoutPageElements = useCallback(() => {
		const scale = cssScale();
		for (const [page, element] of pageElsRef.current) {
			const [width, height] = pageSizeSp(page);
			element.style.width = `${Math.round(width * scale)}px`;
			element.style.height = `${Math.round(height * scale)}px`;
		}
		for (let page = 1; page <= modelRef.current.pagesTotal; page += 1) {
			dirtyRef.current.add(page);
		}
		scheduleRenderRef.current();
	}, [cssScale, pageSizeSp]);

	// ---------------------------------------------------------------------
	// Resource loading

	const ensureResources = useCallback(
		async (lists: readonly DisplayList[]) => {
			const resources = resourcesRef.current;
			const images = imagesRef.current;
			if (!resources || !images || lists.length === 0) return;
			const fonts = fontsRef.current;
			const haveFonts = new Set<string>();
			const haveImages = new Set<string>();
			for (const list of lists) {
				for (const font of Object.values(list.fonts ?? {})) {
					const key = font.filename
						? `file:${font.filename}#${font.subfont ?? 0}`
						: `tfm:${font.name ?? font.id}`;
					if (fonts.has(key)) haveFonts.add(key);
				}
				for (const info of Object.values(list.images_info ?? {})) {
					if (images.has(info.file)) haveImages.add(info.file);
				}
			}
			const [loadedFonts, loadedImages] = await Promise.all([
				resources.fontsFor(lists, haveFonts),
				resources.imagesFor(lists, haveImages),
			]);
			for (const [key, resource] of loadedFonts) fonts.add(key, resource);
			for (const [file, resource] of loadedImages) {
				const info = lists
					.flatMap((list) => Object.values(list.images_info ?? {}))
					.find((entry) => entry.file === file);
				images.add(file, resource, info?.page ?? 1);
			}
			markDirty([...modelRef.current.pages.keys()]);
		},
		[markDirty],
	);

	// ---------------------------------------------------------------------
	// PDF fallback

	const loadLayoutPdf = useCallback(
		async (path: string | null) => {
			if (!path) return;
			if (pdfPathRef.current === path) return;
			const session = sessionRef.current;
			if (!session || !engineRef.current) {
				// The PDFium engine may still be booting; the effect below
				// retries once it is ready.
				pendingPdfPathRef.current = path;
				return;
			}
			const result = await commands.rtexReadTexFile(session.id, path);
			if (!result.ok || !result.data) return;
			const binary = atob(result.data);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i += 1)
				bytes[i] = binary.charCodeAt(i);
			try {
				const doc = await openPdfDocument(
					bytes,
					`rtex-layout-${session.id}-${++pdfSerialRef.current}`,
				);
				const previous = pdfDocRef.current;
				pdfDocRef.current = doc;
				pdfPathRef.current = path;
				pendingPdfPathRef.current = null;
				if (previous) {
					const pdf = engineRef.current;
					if (pdf)
						void taskToPromise(pdf.closeDocument(previous)).catch(
							() => undefined,
						);
				}
				markDirty([...modelRef.current.pages.keys()]);
			} catch {
				// A broken fallback PDF leaves exact pages visible; the next
				// layout retries with a new file.
			}
		},
		[markDirty, openPdfDocument],
	);

	// ---------------------------------------------------------------------
	// Page rendering

	const renderPdfPage = useCallback(
		async (
			ctx: CanvasRenderingContext2D,
			page: number,
			width: number,
			height: number,
		) => {
			const doc = pdfDocRef.current;
			const pdf = engineRef.current;
			if (!doc || !pdf) throw new Error("layout PDF is unavailable");
			const pdfPage: PdfPageObject | undefined = doc.pages[page - 1];
			if (!pdfPage) throw new Error(`layout PDF has no page ${page}`);
			const scale = Math.min(
				width / pdfPage.size.width,
				height / pdfPage.size.height,
			);
			const blob = await taskToPromise(
				pdf.renderPage(doc, pdfPage, {
					scaleFactor: scale,
					imageType: "image/png",
					withAnnotations: false,
					withForms: false,
				}),
			);
			const bitmap = await createImageBitmap(blob);
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.drawImage(bitmap, 0, 0, width, height);
			bitmap.close();
		},
		[],
	);

	const renderPage = useCallback(
		async (page: number) => {
			const element = pageElsRef.current.get(page);
			const update = modelRef.current.pages.get(page);
			if (!element || !update) return;
			const token = (renderTokenRef.current.get(page) ?? 0) + 1;
			renderTokenRef.current.set(page, token);

			const scale = cssScale();
			const dpr = window.devicePixelRatio || 1;
			const [widthSp, heightSp] = pageSizeSp(page);
			const width = Math.max(1, Math.round(widthSp * scale * dpr));
			const height = Math.max(1, Math.round(heightSp * scale * dpr));

			const images = imagesRef.current;
			if (!images) return;
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, width, height);
			const base: Mat = [scale * dpr, 0, 0, scale * dpr, 0, 0];

			const hidden = modelRef.current.hiddenLines(page);
			const lines = update.dl.lines.filter((_, index) => !hidden.has(index));
			const reason = update.exact
				? inexactReason(update.dl, fontsRef.current, images, lines)
				: "contains drawing commands (e.g. TikZ)";
			const usePdf = reason !== undefined && pdfDocRef.current !== null;

			const drawDisplayList = () => {
				const painter = new Painter(ctx, base, fontsRef.current, images);
				painter.draw(update.dl, update.dl.other ?? []);
				for (const line of lines) painter.draw(update.dl, line.items);
			};

			const overlays = modelRef.current.overlaysOn(page);
			let pictureSnaps: { image: ImageData; destination: Rect }[] = [];
			if (usePdf) {
				try {
					await renderPdfPage(ctx, page, width, height);
				} catch {
					ctx.setTransform(1, 0, 0, 1, 0, 0);
					ctx.fillStyle = "#fff";
					ctx.fillRect(0, 0, width, height);
					drawDisplayList();
				}
				if (renderTokenRef.current.get(page) !== token) return;
				pictureSnaps = overlays.flatMap(({ overlay, rows }) =>
					cachedPictureMoves(
						update.dl,
						rows,
						modelRef.current.ownLines(page, overlay.parId),
					).flatMap(({ src, dst }) => {
						const image = grabRect(ctx, base, src);
						return image ? [{ image, destination: dst }] : [];
					}),
				);
				const painter = new Painter(ctx, base, fontsRef.current, images);
				painter.clearLines(
					update.dl.lines
						.filter((_, index) => hidden.has(index))
						.map((line) => ({ line, dx: 0, dy: 0 })),
					"#fff",
				);
			} else {
				drawDisplayList();
			}

			const painters = overlays.map(
				() => new Painter(ctx, base, fontsRef.current, images),
			);
			overlays.forEach(({ rows }, index) => {
				painters[index].clearRects(rowBands(rows), "#fff");
			});
			for (const { image, destination } of pictureSnaps) {
				putRect(ctx, base, image, destination);
			}
			overlays.forEach(({ overlay, rows }, index) => {
				painters[index].draw(overlay.dl, overlay.dl.other ?? []);
				for (const row of rows) {
					painters[index].draw(overlay.dl, row.line.items, row.dx, row.dy);
				}
			});
			if (renderTokenRef.current.get(page) !== token) return;

			canvas.style.width = element.style.width;
			canvas.style.height = element.style.height;
			const previous = element.querySelector("canvas");
			if (previous) element.replaceChild(canvas, previous);
			else element.appendChild(canvas);
		},
		[cssScale, pageSizeSp, renderPdfPage],
	);

	renderPageRef.current = (page: number) => {
		void renderPage(page);
	};

	scheduleRenderRef.current = () => {
		if (renderScheduledRef.current) return;
		renderScheduledRef.current = true;
		requestAnimationFrame(() => {
			renderScheduledRef.current = false;
			for (const page of [...dirtyRef.current]) {
				if (!visibleRef.current.has(page)) continue;
				dirtyRef.current.delete(page);
				renderPageRef.current(page);
			}
		});
	};

	// ---------------------------------------------------------------------
	// Session + events

	useEffect(() => {
		// `retryKey` is a restart trigger, not an input.
		void retryKey;
		let disposed = false;
		let unlisten: UnlistenFn | null = null;
		let pending: RtexEventPayload[] = [];
		let sessionId: string | null = null;

		const handle = (event: RtexEvent) => {
			switch (event.event) {
				case "LayoutUpdate": {
					const layout = event as LayoutUpdateEvent;
					if (sessionId) cacheLayout(sessionId, layout);
					const model = modelRef.current;
					const keepFromRevision =
						layout.convergence.state === "Stale"
							? layout.convergence.pending_since
							: null;
					const dirty = model.applyLayout({
						pages: layout.pages_changed,
						pagesTotal: layout.pages_total,
						placements: layout.placements,
						keepFromRevision,
					});
					setPageCount(layout.pages_total);
					setStatus(layout.convergence.state === "Stale" ? "waiting" : "live");
					logger.info("[rtex] layout", {
						pages: layout.pages_total,
						changed: layout.pages_changed.length,
						convergence: layout.convergence.state,
					});
					markDirty(dirty);
					layoutPageElements();
					void ensureResources(layout.pages_changed.map((page) => page.dl));
					void loadLayoutPdf(layout.pdf_fallback);
					break;
				}
				case "ParagraphUpdate": {
					const paragraph = event as ParagraphUpdateEvent;
					if (paragraph.status === "removed") {
						markDirty(modelRef.current.dropOverlays([paragraph.par_id]));
						break;
					}
					if (paragraph.status === "error") {
						setError(
							paragraph.diagnostics?.[0]?.message ?? t("fileTree.liveFailed"),
						);
						setStatus("failed");
						break;
					}
					markDirty(
						modelRef.current.applyParagraph(
							paragraph.par_id,
							paragraph.dl,
							paragraph.fragments,
							paragraph.versions.source_revision,
						),
					);
					setStatus("live");
					void ensureResources([paragraph.dl]);
					break;
				}
				case "Diagnostics": {
					// Background warnings (undefined citations, missing bibtex)
					// are non-fatal; the page layout still arrives.
					break;
				}
				case "EngineState": {
					if (event.state === "Restarting" || event.state === "Starting") {
						setStatus("restarting");
					} else if (event.state === "Failed") {
						setStatus("failed");
						setError(event.reason ?? t("fileTree.liveFailed"));
					} else if (event.state === "Ready") {
						setStatus((current) => (current === "failed" ? "live" : current));
					}
					break;
				}
				case "BackgroundScheduled": {
					setStatus("waiting");
					break;
				}
				default:
					break;
			}
		};

		const onEvent = (payload: RtexEventPayload) => {
			logger.debug("[rtex] event", {
				sessionId: payload?.sessionId,
				kind: payload?.event?.event,
				want: sessionId,
			});
			if (!sessionId) {
				pending.push(payload);
				return;
			}
			if (payload.sessionId !== sessionId) return;
			handle(payload.event);
		};

		void (async () => {
			try {
				if (!vaultPath) throw new Error("No vault is open");
				unlisten = await listen<RtexEventPayload>("rtex:event", (event) =>
					onEvent(event.payload),
				);
				const session = await startTexLiveSession(rootPath, vaultPath);
				if (disposed) {
					await stopTexLiveSession(session.id);
					return;
				}
				sessionRef.current = session;
				sessionId = session.id;
				// Resource loading must be ready before a cached/first layout
				// requests fonts and images.
				resourcesRef.current = new ResourceLoader(
					session.id,
					session.projectRoot,
					(message) => console.warn(`[rtex] ${message}`),
				);
				setStatus("starting");
				setError(null);
				const queued = pending;
				pending = [];
				for (const payload of queued) {
					if (payload.sessionId === session.id) handle(payload.event);
				}
				const cached = cachedLayout(session.id);
				if (cached) handle(cached);
				void commands.rtexRequestLayout(session.id);
				logger.info("[rtex] session ready", {
					id: session.id,
					root: session.mainFile,
					refs: session.refs,
				});
			} catch (cause) {
				if (disposed) return;
				logger.error("[rtex] session start failed", {
					error: errorText(cause),
				});
				setStatus("failed");
				setError(errorText(cause));
			}
		})();

		return () => {
			disposed = true;
			unlisten?.();
			const session = sessionRef.current;
			sessionRef.current = null;
			if (session) void stopTexLiveSession(session.id);
			const pdf = engineRef.current;
			if (pdf && pdfDocRef.current) {
				void taskToPromise(pdf.closeDocument(pdfDocRef.current)).catch(
					() => undefined,
				);
			}
			pdfDocRef.current = null;
			pdfPathRef.current = null;
		};
		// retryKey intentionally restarts the whole session.
	}, [
		rootPath,
		vaultPath,
		retryKey,
		ensureResources,
		layoutPageElements,
		loadLayoutPdf,
		markDirty,
		t,
	]);

	// ---------------------------------------------------------------------
	// Page elements / zoom / visibility

	useEffect(() => {
		if (!engine) return;
		const pending = pendingPdfPathRef.current;
		if (pending) void loadLayoutPdf(pending);
	}, [engine, loadLayoutPdf]);

	useEffect(() => {
		// Re-observe after the page-count change rendered new elements.
		void pageCount;
		const viewport = viewportRef.current;
		const container = pagesRef.current;
		if (!viewport || !container) return;
		if (!observerRef.current) {
			observerRef.current = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						const page = Number((entry.target as HTMLElement).dataset.page);
						if (!Number.isFinite(page)) continue;
						if (entry.isIntersecting) visibleRef.current.add(page);
						else visibleRef.current.delete(page);
					}
					scheduleRenderRef.current();
				},
				{ root: viewport, rootMargin: "120% 0px" },
			);
		}
		const observer = observerRef.current;
		for (const element of pageElsRef.current.values()) {
			observer.observe(element);
		}
		return () => {
			observer.disconnect();
			observerRef.current = null;
		};
	}, [pageCount]);

	useEffect(() => {
		void pageCount;
		layoutPageElements();
	}, [layoutPageElements, pageCount]);

	useEffect(() => {
		if (active) scheduleRenderRef.current();
	}, [active]);

	useEffect(() => {
		useTexLiveStatusStore.getState().setStatus(
			rootPath,
			{
				status,
				error: status === "failed" ? error : null,
			},
			statusOwner,
		);
	}, [rootPath, status, error, statusOwner]);

	useEffect(
		() => () =>
			useTexLiveStatusStore.getState().clearStatus(rootPath, statusOwner),
		[rootPath, statusOwner],
	);

	return (
		<div
			className={cn(
				"relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-muted/30",
				className,
			)}
		>
			<div ref={viewportRef} className="relative min-h-0 flex-1 overflow-auto">
				<div
					ref={pagesRef}
					className="mx-auto flex w-fit flex-col items-center py-4"
					style={{ gap: PAGE_GAP } as CSSProperties}
				>
					{Array.from({ length: pageCount }, (_, index) => {
						const page = index + 1;
						return (
							<div
								key={page}
								data-page={page}
								className="relative overflow-hidden rounded-sm bg-white shadow-raised ring-1 ring-black/5"
								ref={(element) => {
									if (element) pageElsRef.current.set(page, element);
									else pageElsRef.current.delete(page);
								}}
							/>
						);
					})}
				</div>

				{pageCount === 0 && status !== "failed" ? (
					<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="size-5 animate-spin" aria-hidden />
						<span>{t("fileTree.liveFirstPage")}</span>
					</div>
				) : null}

				{status === "failed" ? (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 px-6 text-center">
						<p className="max-w-md text-muted-foreground text-sm">
							{error ?? t("fileTree.liveFailed")}
						</p>
						<Button
							type="button"
							size="sm"
							variant="secondary"
							onClick={() => setRetryKey((value) => value + 1)}
						>
							<RefreshCw className="size-3.5" aria-hidden />
							{t("fileTree.liveRetry")}
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}
