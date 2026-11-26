import { useDocumentState, useRegistry } from "@embedpdf/core/react";
import {
	ignore,
	PdfErrorCode,
	type Rect,
	transformRect,
} from "@embedpdf/models";
import { useRenderCapability } from "@embedpdf/plugin-render/react";
import { ScrollPlugin, type ScrollState } from "@embedpdf/plugin-scroll";
import {
	type Tile,
	TilingPlugin,
	type TilingState,
} from "@embedpdf/plugin-tiling";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import {
	PAGE_LAYER_STYLE,
	pdfTileDpr,
} from "@/components/viewer/pdf/constants";
import { pdfPageRenderRotation } from "./agentero-render-layer";

const EMPTY_TILES: readonly Tile[] = [];

function useViewportTiles(documentId: string, pageIndex: number) {
	const { registry } = useRegistry();
	const store = registry?.getStore();
	const subscribe = useCallback(
		(notify: () => void) => {
			if (!store) return () => {};
			const offTiles = store.subscribeToPlugin(TilingPlugin.id, notify);
			const offScroll = store.subscribeToPlugin(ScrollPlugin.id, notify);
			return () => {
				offTiles();
				offScroll();
			};
		},
		[store],
	);
	const snapshot = () => {
		const state = store?.getState().plugins;
		const scrollState: ScrollState | undefined = state?.[ScrollPlugin.id];
		const tilingState: TilingState | undefined = state?.[TilingPlugin.id];
		if (
			!scrollState?.documents[documentId]?.visiblePages.includes(pageIndex + 1)
		)
			return EMPTY_TILES;
		return (
			tilingState?.documents[documentId]?.visibleTiles[pageIndex] ?? EMPTY_TILES
		);
	};
	return useSyncExternalStore(subscribe, snapshot, () => EMPTY_TILES);
}

type TileRender = NonNullable<
	ReturnType<typeof useRenderCapability>["provides"]
>["renderPageRect"];

function ReflowTile({
	render,
	pageIndex,
	tile,
	rotation,
	dpr,
	frame,
}: {
	render: TileRender;
	pageIndex: number;
	tile: Tile;
	rotation: ReturnType<typeof pdfPageRenderRotation>;
	dpr: number;
	frame: Rect;
}) {
	const image = useRef<HTMLImageElement>(null);
	const { pageRect, srcScale } = tile;
	useEffect(() => {
		const element = image.current;
		if (!element) return;
		const task = render({
			pageIndex,
			rect: pageRect,
			options: { scaleFactor: srcScale, dpr, rotation },
		});
		let url: string | undefined;
		let active = true;
		task.wait((blob) => {
			if (!active) return;
			url = URL.createObjectURL(blob);
			element.src = url;
		}, ignore);
		return () => {
			active = false;
			element.style.visibility = "hidden";
			if (url) URL.revokeObjectURL(url);
			else
				task.abort({
					code: PdfErrorCode.Cancelled,
					message: "Translation tile left the viewport",
				});
		};
	}, [render, pageIndex, pageRect, srcScale, dpr, rotation]);
	return (
		<img
			ref={image}
			alt=""
			draggable={false}
			onLoad={({ currentTarget }) => {
				// Hidden Dockview panels stay mounted and hide their descendants
				// through inherited visibility.
				if (currentTarget.naturalWidth > 0)
					currentTarget.style.visibility = "inherit";
			}}
			style={{
				position: "absolute",
				visibility: "hidden",
				left: frame.origin.x,
				top: frame.origin.y,
				width: frame.size.width,
				height: frame.size.height,
			}}
		/>
	);
}

export function ReflowTileLayer({
	viewportDocumentId,
	documentId,
	pageIndex,
	className,
}: {
	viewportDocumentId: string;
	documentId: string;
	pageIndex: number;
	className?: string;
}) {
	const viewport = useDocumentState(viewportDocumentId);
	const document = useDocumentState(documentId);
	const { provides: render } = useRenderCapability();
	const scope = useMemo(
		() => render?.forDocument(documentId),
		[render, documentId],
	);
	const tiles = useViewportTiles(viewportDocumentId, pageIndex);
	const page = viewport?.document?.pages[pageIndex];
	const outputPage = document?.document?.pages[pageIndex];
	if (
		!viewport ||
		!page ||
		!outputPage ||
		document.status !== "loaded" ||
		!scope
	)
		return null;
	const rotation = pdfPageRenderRotation(viewport, pageIndex);
	if (
		rotation !== pdfPageRenderRotation(document, pageIndex) ||
		page.size.width !== outputPage.size.width ||
		page.size.height !== outputPage.size.height
	)
		return null;
	const scale = viewport.scale;
	const dpr = pdfTileDpr();
	return (
		<div aria-hidden="true" className={className} style={PAGE_LAYER_STYLE}>
			{tiles
				.filter((tile) => tile.srcScale === scale)
				.map((tile) => (
					<ReflowTile
						key={`${tile.id}:${dpr}:${document.pageRefreshVersions[pageIndex] ?? 0}`}
						render={scope.renderPageRect}
						pageIndex={pageIndex}
						tile={tile}
						rotation={rotation}
						dpr={dpr}
						frame={transformRect(page.size, tile.pageRect, rotation, scale)}
					/>
				))}
		</div>
	);
}
