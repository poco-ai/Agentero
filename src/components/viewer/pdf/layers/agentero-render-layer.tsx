import { useDocumentState } from "@embedpdf/core/react";
import { ignore, PdfErrorCode, type Rotation } from "@embedpdf/models";
import { useRenderCapability } from "@embedpdf/plugin-render/react";
import {
	type CSSProperties,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { pageBitmapCache } from "@/components/viewer/pdf/layers/page-bitmap-cache";

type AgenteroRenderLayerProps = {
	pageRef: RefObject<HTMLDivElement | null>;
	documentId: string;
	pageIndex: number;
	scale?: number;
	dpr?: number;
	className?: string;
	style?: CSSProperties;
};

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
	const documentState = useDocumentState(documentId);
	const cacheId = `${documentId}:${pageIndex}`;
	const [imageUrl, setImageUrl] = useState<string | null>(() =>
		pageBitmapCache.retain(cacheId),
	);
	const pinnedId = useRef(cacheId);
	const retiredRef = useRef<string[]>([]);
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
	const documentLoaded =
		documentState?.status === "loaded" && Boolean(documentState.document);

	useEffect(() => {
		const id = `${documentId}:${pageIndex}`;
		if (pinnedId.current !== id) {
			pageBitmapCache.release(pinnedId.current);
			pinnedId.current = id;
			setImageUrl(pageBitmapCache.retain(id));
		}
		return () => {
			pageBitmapCache.release(id);
			pinnedId.current = "";
		};
	}, [documentId, pageIndex]);

	useEffect(() => {
		const retired = retiredRef.current;
		if (retired.length === 0) return;
		retiredRef.current = [];
		for (const url of retired) {
			if (url !== imageUrl) URL.revokeObjectURL(url);
		}
	}, [imageUrl]);

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

	useEffect(() => {
		if (!renderProvides || !visible || !documentLoaded) return;
		const id = `${documentId}:${pageIndex}`;
		if (pageBitmapCache.matches(id, renderKey)) return;
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
			if (cancelled) return;
			const url = URL.createObjectURL(blob);
			retiredRef.current.push(
				...pageBitmapCache
					.store(id, url, renderKey)
					.filter((old) => old !== url),
			);
			setImageUrl(url);
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
		renderKey,
		visible,
		documentLoaded,
	]);

	if (!imageUrl) return null;
	return (
		<img
			src={imageUrl}
			alt=""
			aria-hidden="true"
			draggable={false}
			className={className}
			style={{ width: "100%", height: "100%", ...style }}
		/>
	);
}
