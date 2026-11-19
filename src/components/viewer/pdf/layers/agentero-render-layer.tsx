import { useDocumentState } from "@embedpdf/core/react";
import { ignore, PdfErrorCode, type Rotation } from "@embedpdf/models";
import { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { useRenderCapability } from "@embedpdf/plugin-render/react";
import {
	type CSSProperties,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	createPageBitmap,
	type PageBitmap,
	pageBitmapCache,
} from "@/components/viewer/pdf/layers/page-bitmap-cache";

type AgenteroRenderLayerProps = {
	pageRef: RefObject<HTMLDivElement | null>;
	documentId: string;
	pageIndex: number;
	scale?: number;
	dpr?: number;
	className?: string;
	style?: CSSProperties;
};

export function PdfPageBitmapCacheLifecycle() {
	const { provides: documents } = useDocumentManagerCapability();
	useEffect(() => {
		if (!documents) return;
		const unsubscribe = documents.onDocumentClosed((id) =>
			pageBitmapCache.clear(documents, id),
		);
		return () => {
			unsubscribe();
			pageBitmapCache.clear(documents);
		};
	}, [documents]);
	return null;
}

export function pdfPageRenderRotation(
	documentState: ReturnType<typeof useDocumentState>,
	pageIndex: number,
): Rotation {
	// `normalizeRotation: true` reports the unrotated content-space size and
	// keeps /Rotate in `page.rotation`; the raster is only upright when the
	// caller re-applies it (see test/pdf-page-rotation.test.ts).
	const pageRotation = documentState?.document?.pages[pageIndex]?.rotation ?? 0;
	return ((((pageRotation + (documentState?.rotation ?? 0)) % 4) + 4) %
		4) as Rotation;
}

export function AgenteroRenderLayer({
	pageRef,
	documentId,
	pageIndex,
	scale: scaleOverride,
	dpr: dprOverride,
	className,
	style,
}: AgenteroRenderLayerProps) {
	const { provides: renderProvides } = useRenderCapability();
	const { provides: documents } = useDocumentManagerCapability();
	const documentState = useDocumentState(documentId);
	const [image, setImage] = useState<{
		scope: object;
		documentId: string;
		pageIndex: number;
		key: string;
		bitmap: PageBitmap;
	} | null>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const refreshVersion = useMemo(() => {
		if (!documentState) return 0;
		return documentState.pageRefreshVersions[pageIndex] || 0;
	}, [documentState, pageIndex]);
	const actualScale = useMemo(() => {
		if (scaleOverride !== undefined) return scaleOverride;
		return documentState?.scale ?? 1;
	}, [scaleOverride, documentState?.scale]);
	const actualDpr = useMemo(() => {
		if (dprOverride !== undefined) return dprOverride;
		return window.devicePixelRatio;
	}, [dprOverride]);
	const rotation = useMemo(
		() => pdfPageRenderRotation(documentState, pageIndex),
		[documentState, pageIndex],
	);
	// The render plugin throws when the document is still opening (hidden
	// translation display documents load asynchronously). Wait for the loaded
	// state; the static per-page preview stays visible until then.
	const loadedDocument =
		documentState?.status === "loaded" ? documentState.document : null;

	useLayoutEffect(() => {
		const cached =
			documents && pageBitmapCache.get(documents, documentId, pageIndex);
		setImage(cached ? { ...cached, pageIndex } : null);
	}, [documents, documentId, pageIndex]);

	const displayedBitmap =
		loadedDocument &&
		image?.scope === documents &&
		image?.documentId === documentId &&
		image.pageIndex === pageIndex
			? image.bitmap
			: null;
	useLayoutEffect(() => {
		const element = imageRef.current;
		if (!displayedBitmap || !element) return;
		const { url, release } = displayedBitmap.retain();
		element.src = url;
		return release;
	}, [displayedBitmap]);

	// Scroller mounts buffer pages too. Their CRITICAL full-page renders would
	// queue ahead of visible HIGH-priority tiles and user-requested crops.
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const page = pageRef.current;
		if (!page) return;
		if (typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			setVisible(entries.some((entry) => entry.isIntersecting));
		});
		observer.observe(page);
		return () => observer.disconnect();
	}, [pageRef]);

	const renderKey = `${actualScale}|${actualDpr}|${rotation}|${refreshVersion}`;
	const displayedKey = displayedBitmap ? image?.key : undefined;

	useEffect(() => {
		if (
			!renderProvides ||
			!documents ||
			!visible ||
			!loadedDocument ||
			displayedKey === renderKey
		)
			return;
		const cached = pageBitmapCache.get(documents, documentId, pageIndex);
		if (cached?.key === renderKey) {
			setImage({ ...cached, pageIndex });
			return;
		}
		let settled = false;
		let cancelled = false;
		const task = renderProvides.forDocument(documentId).renderPage({
			pageIndex,
			options: {
				scaleFactor: actualScale,
				dpr: actualDpr,
				rotation,
			},
		});
		task.wait((blob) => {
			settled = true;
			if (cancelled || documents.getDocument(documentId) !== loadedDocument)
				return;
			const next = {
				scope: documents,
				documentId,
				key: renderKey,
				bitmap: createPageBitmap(blob),
			};
			pageBitmapCache.store(next, pageIndex);
			setImage({ ...next, pageIndex });
		}, ignore);
		return () => {
			cancelled = true;
			if (settled) return;
			task.abort({
				code: PdfErrorCode.Cancelled,
				message: "canceled render task",
			});
		};
	}, [
		documentId,
		pageIndex,
		actualScale,
		actualDpr,
		rotation,
		renderProvides,
		documents,
		renderKey,
		displayedKey,
		visible,
		loadedDocument,
	]);

	if (!displayedBitmap) return null;
	return (
		<img
			ref={imageRef}
			alt=""
			aria-hidden="true"
			draggable={false}
			className={className}
			style={{ width: "100%", height: "100%", ...style }}
		/>
	);
}
