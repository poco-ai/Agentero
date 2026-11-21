import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { listen } from "@tauri-apps/api/event";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { EMBED_PAGE_ATTR, pageElByIndex } from "@/components/viewer/pdf/coords";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import type { PdfNavigationRegion } from "@/lib/pdf/pending-pdf-page";
import { navigateTexSource } from "@/lib/tex/editor-navigation";
import { type LatexCompileResult, syncTexBackward } from "@/lib/tex/host";
import { registerTexPdfViewer } from "@/lib/tex/synctex";
import {
	indexSyncTexBoxes,
	readSyncTexBoxes,
	type SyncTexBox,
	samePdfPath,
	setSyncTexHover,
	syncTexBoxAtPoint,
} from "@/lib/tex/synctex-boxes";
import {
	syncTexClickPoint,
	syncTexHighlightBox,
} from "@/lib/tex/synctex-geometry";

export function usePdfSyncTex(options: {
	docId: string;
	tabId: string;
	pdfPath?: string | null;
	rootPath?: string | null;
	scope?: "writing";
	cloudSyncBackward?: (
		page: number,
		x: number,
		y: number,
	) => Promise<{ path: string; line: number; column: number } | null>;
	isActive: boolean;
	hostRef: RefObject<HTMLDivElement | null>;
	navigate(region: PdfNavigationRegion): void;
	docCapRef: RefObject<
		ReturnType<typeof useDocumentManagerCapability>["provides"]
	>;
}): void {
	const latest = useRef(options);
	latest.current = options;
	const { provides: scrollCapability } = useScrollCapability();
	const { docId, pdfPath, rootPath, hostRef, scope } = options;
	const navigation = useRef(0);
	const lastPoint = useRef<{
		docId: string;
		index: number;
		x: number;
		y: number;
	} | null>(null);

	const syncBackward = useCallback(
		(index: number, point: { x: number; y: number }) => {
			if (!pdfPath) return false;
			const request = ++navigation.current;
			const cloud = latest.current.cloudSyncBackward;
			void (
				cloud
					? cloud(index + 1, point.x, point.y)
					: syncTexBackward(pdfPath, index + 1, point.x, point.y)
			)
				.then((source) => {
					if (request !== navigation.current) return;
					if (source)
						navigateTexSource(source.path, source.line, source.column);
					else notifyError(i18n.t("latexPdf:noMatch"));
				})
				.catch((error) => {
					if (request === navigation.current)
						notifyError(errorText(error) || i18n.t("latexPdf:syncFailed"));
				});
			return true;
		},
		[pdfPath],
	);

	const pagePoint = useCallback(
		(index: number, element: HTMLElement, client: { x: number; y: number }) => {
			const state = latest.current.docCapRef.current?.getDocumentState(docId);
			const page = state?.document?.pages[index];
			if (!page) return null;
			return syncTexClickPoint(
				client,
				element.getBoundingClientRect(),
				page.size,
				(page.rotation + (state?.rotation ?? 0)) % 4,
			);
		},
		[docId],
	);

	/** Reuse the clicked PDF point; before the first click, use the viewport. */
	const syncFromView = useCallback(() => {
		const selected = lastPoint.current;
		if (selected?.docId === docId)
			return syncBackward(selected.index, selected);
		const host = hostRef.current;
		if (!host || !scrollCapability) return false;
		const metrics = scrollCapability.forDocument(docId)?.getMetrics();
		if (!metrics) return false;
		const index = Math.max(0, (metrics.currentPage || 1) - 1);
		const element = pageElByIndex(host, index);
		if (!element) return false;
		const box = element.getBoundingClientRect();
		const view = host.getBoundingClientRect();
		const left = Math.max(box.left, view.left);
		const right = Math.min(box.right, view.right);
		const top = Math.max(box.top, view.top);
		const bottom = Math.min(box.bottom, view.bottom);
		if (right <= left || bottom <= top) return false;
		const point = pagePoint(index, element, {
			x: (left + right) / 2,
			y: (top + bottom) / 2,
		});
		return point ? syncBackward(index, point) : false;
	}, [docId, hostRef, scrollCapability, syncBackward, pagePoint]);

	useEffect(() => {
		if (!pdfPath || !rootPath || !scrollCapability) return;
		let unregister: (() => void) | undefined;
		const off = scrollCapability.onLayoutReady((event) => {
			if (event.documentId !== docId || unregister) return;
			unregister = registerTexPdfViewer(pdfPath, {
				tabId: latest.current.tabId,
				documentId: docId,
				scope: latest.current.scope,
				isActive: () => latest.current.isActive,
				navigate: (location) => {
					const { navigate, docCapRef } = latest.current;
					const size =
						docCapRef.current?.getDocument(docId)?.pages[location.page - 1]
							?.size;
					if (!size) return;
					navigate({
						id: `synctex:${location.page}:${location.x}:${location.y}`,
						pageIndex: location.page - 1,
						bbox: syncTexHighlightBox(location, size),
						kind: "text",
					});
				},
				...(scope === "writing" ? { syncFromView } : {}),
			});
		});
		return () => {
			off();
			unregister?.();
		};
	}, [docId, pdfPath, rootPath, scrollCapability, scope, syncFromView]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !pdfPath || !rootPath) return;
		const click = (event: MouseEvent) => {
			if (event.button !== 0) return;
			const element =
				event.target instanceof Element
					? event.target.closest<HTMLElement>(`[${EMBED_PAGE_ATTR}]`)
					: null;
			if (!element || !host.contains(element)) return;
			const index = Number(element.getAttribute(EMBED_PAGE_ATTR));
			const point = pagePoint(index, element, {
				x: event.clientX,
				y: event.clientY,
			});
			if (!point) return;
			lastPoint.current = { docId, index, ...point };
			// Selecting text in the PDF must stay local. Only a modified click
			// (⌘/Ctrl + click) is an explicit reverse-sync request.
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			event.stopPropagation();
			syncBackward(index, point);
		};
		host.addEventListener("click", click, true);
		return () => {
			navigation.current += 1;
			host.removeEventListener("click", click, true);
		};
	}, [docId, pdfPath, rootPath, hostRef, syncBackward, pagePoint]);

	const boxesRef = useRef<ReadonlyMap<number, readonly SyncTexBox[]>>(
		new Map(),
	);
	useEffect(() => {
		if (scope !== "writing" || !pdfPath) return;
		let cancelled = false;
		const load = () => {
			setSyncTexHover(docId, "loading");
			void readSyncTexBoxes(pdfPath)
				.then((boxes) => {
					if (cancelled) return;
					boxesRef.current = indexSyncTexBoxes(boxes);
					setSyncTexHover(docId, boxes.length > 0 ? "ready" : "absent");
				})
				.catch(() => {
					if (cancelled) return;
					boxesRef.current = new Map();
					setSyncTexHover(docId, "absent");
				});
		};
		load();
		let unlisten: (() => void) | undefined;
		void listen<LatexCompileResult>("compile:finished", ({ payload }) => {
			if (samePdfPath(payload.pdfPath, pdfPath)) load();
		}).then(
			(off) => {
				if (cancelled) off();
				else unlisten = off;
			},
			() => undefined,
		);
		return () => {
			cancelled = true;
			unlisten?.();
			boxesRef.current = new Map();
			setSyncTexHover(docId, null);
		};
	}, [docId, pdfPath, scope]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || scope !== "writing" || !pdfPath) return;
		let raf = 0;
		let pending: PointerEvent | null = null;
		const hoverLayer = (page: HTMLElement) => {
			let layer = page.querySelector<HTMLElement>(
				":scope > [data-synctex-hover]",
			);
			if (!layer) {
				layer = document.createElement("div");
				layer.dataset.synctexHover = "";
				layer.dataset.sourceSentence = "";
				// Hover weight and shape come from the paper-mark tokens.
				layer.className = "pdf-layout-sentence-wash is-on";
				layer.style.zIndex = "6";
				layer.setAttribute("aria-hidden", "true");
				layer.append(document.createElement("span"));
				page.append(layer);
			}
			return layer;
		};
		const clear = () => {
			for (const node of host.querySelectorAll("[data-synctex-hover]"))
				node.remove();
		};
		const apply = () => {
			raf = 0;
			const event = pending;
			pending = null;
			if (!event) return;
			if (
				event.buttons !== 0 ||
				host.hasAttribute("data-pdf-selecting") ||
				(event.target instanceof Element &&
					event.target.closest("[data-pdf-chrome], [data-selection-menu]"))
			) {
				clear();
				return;
			}
			const page =
				event.target instanceof Element
					? event.target.closest<HTMLElement>(`[${EMBED_PAGE_ATTR}]`)
					: null;
			const index = Number(page?.getAttribute(EMBED_PAGE_ATTR));
			if (!page || !host.contains(page) || !Number.isInteger(index)) {
				clear();
				return;
			}
			const point = pagePoint(index, page, {
				x: event.clientX,
				y: event.clientY,
			});
			const size =
				latest.current.docCapRef.current?.getDocument(docId)?.pages[index]
					?.size;
			const hit =
				point && size
					? syncTexBoxAtPoint(boxesRef.current, index + 1, point.x, point.y)
					: null;
			if (!hit || !size || size.width <= 0 || size.height <= 0) {
				clear();
				return;
			}
			for (const node of host.querySelectorAll("[data-synctex-hover]")) {
				if (node.parentElement !== page) node.remove();
			}
			const span = hoverLayer(page).firstElementChild;
			if (!(span instanceof HTMLElement)) return;
			span.style.left = `${(hit.x / size.width) * 100}%`;
			span.style.top = `${(hit.y / size.height) * 100}%`;
			span.style.width = `${(hit.w / size.width) * 100}%`;
			span.style.height = `${(hit.h / size.height) * 100}%`;
		};
		const onMove = (event: PointerEvent) => {
			pending = event;
			if (raf) return;
			raf = requestAnimationFrame(apply);
		};
		const onLeave = () => {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			pending = null;
			clear();
		};
		host.addEventListener("pointermove", onMove, true);
		host.addEventListener("pointerleave", onLeave);
		return () => {
			if (raf) cancelAnimationFrame(raf);
			host.removeEventListener("pointermove", onMove, true);
			host.removeEventListener("pointerleave", onLeave);
			clear();
		};
	}, [docId, hostRef, pagePoint, pdfPath, scope]);
}
