import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fontSizeForLayoutTranslateBox } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import { cn } from "@/lib/core/utils";
import { paperDirFromPath } from "@/lib/paper/detect";
import {
	currentLayoutTranslateCacheKey,
	type LayoutTranslateItem,
	type LayoutTranslateSidecar,
	type PdfLayoutSidecar,
	readLayoutSidecar,
	readLayoutTranslateSidecar,
} from "@/lib/pdf/layout";
import { isLayoutTranslateHeadingKind } from "@/lib/pdf/layout/labels";
import {
	PDF_PAGE_RASTER_DARK_CLASS,
	PDF_PAPER_BLOCK_CLASS,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";
import { joinVaultPath } from "@/lib/vault";

type TranslationViewProps = {
	/** Active document path broadcast from the main window. */
	selectedPath: string | null;
	/** Current vault root. */
	vaultPath: string | null;
	/** Vault-relative paper folder paths used to map any path to its paper unit. */
	vaultPaperPaths: string[];
};

type PageSize = { width: number; height: number };

type PageRenderSpec = {
	pageIndex: number;
	pageSize: PageSize;
	items: readonly LayoutTranslateItem[];
};

const POINTS_PER_PX = 72 / 96;

function estimatePageSizesFromRegions(
	regions: PdfLayoutSidecar["regions"],
): Map<number, PageSize> {
	const sizes = new Map<number, PageSize>();
	const pages = new Set(regions.map((r) => r.pageIndex));
	for (const pageIndex of pages) {
		let width = 0;
		let height = 0;
		for (const r of regions) {
			if (r.pageIndex !== pageIndex) continue;
			if (r.bbox.w > 0.02) width = Math.max(width, r.rect.w / r.bbox.w);
			if (r.bbox.h > 0.02) height = Math.max(height, r.rect.h / r.bbox.h);
		}
		if (width > 0 && height > 0) {
			sizes.set(pageIndex, { width, height });
		}
	}
	return sizes;
}

function toLayoutTranslateItem(
	item: LayoutTranslateSidecar["items"][number],
): LayoutTranslateItem {
	return { ...item, status: "done" as const };
}

function groupItemsByPage(
	items: LayoutTranslateSidecar["items"] | undefined,
): Map<number, LayoutTranslateItem[]> {
	const grouped = new Map<number, LayoutTranslateItem[]>();
	if (!items) return grouped;
	for (const item of items) {
		const layoutItem = toLayoutTranslateItem(item);
		const bucket = grouped.get(layoutItem.pageIndex);
		if (bucket) bucket.push(layoutItem);
		else grouped.set(layoutItem.pageIndex, [layoutItem]);
	}
	for (const bucket of grouped.values()) {
		bucket.sort(
			(a, b) =>
				a.readingOrder - b.readingOrder ||
				a.bbox.y - b.bbox.y ||
				a.bbox.x - b.bbox.x,
		);
	}
	return grouped;
}

function buildPageSpecs(
	layout: PdfLayoutSidecar | null,
	translate: LayoutTranslateSidecar | null,
): PageRenderSpec[] {
	if (!layout) return [];
	const pageSizes = estimatePageSizesFromRegions(layout.regions);
	const itemsByPage = groupItemsByPage(translate?.items);
	const pageIndexes = new Set<number>();
	for (const idx of pageSizes.keys()) pageIndexes.add(idx);
	for (const idx of itemsByPage.keys()) pageIndexes.add(idx);
	const specs: PageRenderSpec[] = [];
	for (const pageIndex of [...pageIndexes].sort((a, b) => a - b)) {
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize) continue;
		const items = itemsByPage.get(pageIndex) ?? [];
		specs.push({ pageIndex, pageSize, items });
	}
	return specs;
}

function TranslatedBlock({
	item,
	pageWidthPx,
	pageHeightPx,
	tone,
}: {
	item: LayoutTranslateItem;
	pageWidthPx: number;
	pageHeightPx: number;
	tone: PdfPaperTone;
}) {
	const text = item.translated ?? "";
	const isHeading = isLayoutTranslateHeadingKind(item.kind);
	const fontSize = fontSizeForLayoutTranslateBox(
		item.bbox,
		pageWidthPx,
		pageHeightPx,
		item.source,
		text,
	);
	return (
		<div
			className={cn(
				"absolute z-[1] overflow-hidden rounded-[1px]",
				PDF_PAPER_BLOCK_CLASS[tone],
				"text-zinc-900",
				tone === "dark" && PDF_PAGE_RASTER_DARK_CLASS,
			)}
			style={{
				left: `${item.bbox.x * 100}%`,
				top: `${item.bbox.y * 100}%`,
				width: `${item.bbox.w * 100}%`,
				height: `${item.bbox.h * 100}%`,
				padding: "1px 2px",
				fontSize,
				lineHeight: 1.25,
				fontFamily:
					'ui-serif, "Times New Roman", Times, "Noto Serif SC", "Songti SC", "Source Han Serif SC", serif',
				fontWeight: isHeading ? 700 : 400,
				textAlign: isHeading ? "left" : "justify",
			}}
		>
			<p
				className={cn(
					"m-0 h-full w-full overflow-hidden break-words whitespace-pre-wrap",
					isHeading && "font-bold",
				)}
			>
				{text}
			</p>
		</div>
	);
}

function TranslatedPage({
	spec,
	tone,
}: {
	spec: PageRenderSpec;
	tone: PdfPaperTone;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [renderSize, setRenderSize] = useState<{
		width: number;
		height: number;
	}>({ width: 0, height: 0 });

	useEffect(() => {
		const update = () => {
			const containerWidth = containerRef.current?.clientWidth ?? 0;
			const naturalWidth = spec.pageSize.width / POINTS_PER_PX;
			const naturalHeight = spec.pageSize.height / POINTS_PER_PX;
			const maxWidth = Math.max(320, containerWidth - 32);
			const scale =
				containerWidth > 0 ? Math.min(1, maxWidth / naturalWidth) : 1;
			setRenderSize({
				width: naturalWidth * scale,
				height: naturalHeight * scale,
			});
		};
		update();
		const ro = new ResizeObserver(update);
		if (containerRef.current) ro.observe(containerRef.current);
		return () => ro.disconnect();
	}, [spec.pageSize.width, spec.pageSize.height]);

	const doneItems = spec.items.filter(
		(it) => it.status === "done" && it.translated?.trim(),
	);

	return (
		<div
			ref={containerRef}
			className="flex min-h-0 w-full items-start justify-center py-3"
		>
			<div
				className={cn(
					"relative shrink-0 overflow-hidden shadow-sm",
					PDF_PAPER_BLOCK_CLASS[tone],
					tone === "dark" && PDF_PAGE_RASTER_DARK_CLASS,
				)}
				style={{
					width: renderSize.width,
					height: renderSize.height,
				}}
			>
				{doneItems.map((item) => (
					<TranslatedBlock
						key={item.id}
						item={item}
						pageWidthPx={renderSize.width}
						pageHeightPx={renderSize.height}
						tone={tone}
					/>
				))}
			</div>
		</div>
	);
}

export function TranslationView({
	selectedPath,
	vaultPath,
	vaultPaperPaths,
}: TranslationViewProps) {
	const { t } = useTranslation("viewer");
	const { resolvedTheme } = useTheme();
	const [layoutSidecar, setLayoutSidecar] = useState<PdfLayoutSidecar | null>(
		null,
	);
	const [translateSidecar, setTranslateSidecar] =
		useState<LayoutTranslateSidecar | null>(null);

	const paperAbsPath = useMemo(() => {
		if (!selectedPath || !vaultPath) return null;
		const paperDir = paperDirFromPath(selectedPath, vaultPaperPaths);
		if (!paperDir) return null;
		return paperDir.startsWith("/")
			? paperDir
			: joinVaultPath(vaultPath, paperDir);
	}, [selectedPath, vaultPath, vaultPaperPaths]);

	useEffect(() => {
		setLayoutSidecar(null);
		setTranslateSidecar(null);
		if (!paperAbsPath) return;
		let cancelled = false;
		void (async () => {
			const [layout, translate] = await Promise.all([
				readLayoutSidecar(paperAbsPath),
				readLayoutTranslateSidecar(
					paperAbsPath,
					currentLayoutTranslateCacheKey(),
				),
			]);
			if (cancelled) return;
			setLayoutSidecar(layout);
			setTranslateSidecar(translate);
		})();
		return () => {
			cancelled = true;
		};
	}, [paperAbsPath]);

	const pages = useMemo(
		() => buildPageSpecs(layoutSidecar, translateSidecar),
		[layoutSidecar, translateSidecar],
	);

	const tone: PdfPaperTone = resolvedTheme === "dark" ? "dark" : "white";

	if (!paperAbsPath) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
				{t("pdf.translation.noPaper")}
			</div>
		);
	}

	if (pages.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
				{t("pdf.translation.empty")}
			</div>
		);
	}

	return (
		<div className="agentero-scroll flex h-full flex-col overflow-auto bg-muted/20">
			{pages.map((spec) => (
				<TranslatedPage key={spec.pageIndex} spec={spec} tone={tone} />
			))}
		</div>
	);
}
