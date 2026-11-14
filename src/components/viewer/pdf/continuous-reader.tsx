import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { Loader2, LocateFixed } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import {
	memo,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ScrollBar } from "@/components/ui/scroll-area";
import { CitationLinkLayer } from "@/components/viewer/pdf/layers/citation-links";

import { readerCropBlob } from "@/components/viewer/pdf/reader-crop-cache";
import { ReaderEquation } from "@/components/viewer/pdf/reader-equation";
import {
	type ReaderFormulaContent,
	readerFormulaText,
} from "@/components/viewer/pdf/reader-formula-text";

import {
	type ReaderLinkHandlers,
	type ReaderPageLinks,
	ReaderText,
} from "@/components/viewer/pdf/reader-text";

import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

import type { JumpOrigin } from "@/lib/pdf/jump-back-stack";
import { layoutKindI18nKey } from "@/lib/pdf/layout/labels";
import { translatedTextLinkKey } from "@/lib/pdf/layout/link-ink";
import type { TranslatedLinkSource } from "@/lib/pdf/layout/translated-link-source";
import {
	claimTranslateLinks,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import { beginLinkPreviewDrag } from "@/lib/pdf/link-preview-drag";
import { linkTargetUrl } from "@/lib/pdf/link-target";
import type { PdfNavigationTarget } from "@/lib/pdf/pending-pdf-page";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";
import {
	normalizeReadingSettings,
	type ReadingSettings,
	readingColors,
} from "@/lib/pdf/reading/settings";
import { wheelDeltaToZoomRatio } from "@/lib/pdf/wheel-zoom";

type Context = () => { engine: PdfEngine; document: PdfDocumentObject } | null;
function visibleReaderAnchor(root: HTMLElement | null) {
	if (!root) return null;
	const top = root.getBoundingClientRect().top;
	const element = Array.from(
		root.querySelectorAll<HTMLElement>("[data-reader-block]"),
	).find((block) => block.getBoundingClientRect().bottom > top + 48);
	return element
		? { element, top: element.getBoundingClientRect().top - top }
		: null;
}
// PDF points to CSS pixels, with the same 125% reading enlargement as Zotero.
const CROP_DISPLAY_SCALE = (96 / 72) * 1.25;
const ReaderCrop = memo(function ReaderCrop({
	pageIndex,
	bbox,
	label,
	context,
	inline,
	math = false,
	displayFontScale = 1,
	linkSource,
	handlers,
	selectionText,
	selectionGlyphs,

	children,
}: {
	pageIndex: number;
	bbox: PdfAskNormalizedRect;
	label: string;
	context: Context;
	inline?: { fontSize: number; baselineOffset: number; fontScale: number };
	math?: boolean;
	displayFontScale?: number;
	linkSource?: Pick<TranslatedLinkSource, "citationLinks" | "textLinks">;
	handlers?: ReaderLinkHandlers;
	selectionText?: string;
	selectionGlyphs?: ReaderFormulaContent["glyphs"];

	children?: ReactNode;
}) {
	const { t } = useTranslation("viewer");
	const ref = useRef<HTMLSpanElement>(null);
	const [image, setImage] = useState<string | null>(null);
	const imageUrl = useRef<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [nativeContent, setNativeContent] =
		useState<ReaderFormulaContent | null>(null);
	const { x, y, w, h } = bbox;
	const isInline = inline !== undefined;
	const mask = isInline || math;
	const selectable = selectionText || nativeContent?.text;
	const glyphs = selectionGlyphs ?? nativeContent?.glyphs;
	// Inline math follows the reading font, which can exceed the PDF's point
	// size several times over. Keep small symbols crisp at the current zoom.
	const displayScale = CROP_DISPLAY_SCALE * (math ? displayFontScale : 1);
	const rasterScale = inline
		? Math.max(3, (16 * inline.fontScale) / inline.fontSize)
		: displayScale;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Source identity owns the URL; zoom keeps it until a sharper replacement is ready.
	useEffect(() => {
		setImage(null);
		setNativeContent(null);
		return () => {
			if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
			imageUrl.current = null;
		};
	}, [pageIndex, x, y, w, h, context, mask, selectionText]);
	useEffect(() => {
		let cancelled = false,
			visible = false,
			pending = false;
		let url: string | null = null;
		const release = () => {
			if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
			imageUrl.current = null;
			url = null;
		};
		setFailed(false);
		const load = async () => {
			if (pending || url || cancelled || !visible) return;
			const ctx = context();
			if (!ctx) {
				setFailed(true);
				return;
			}
			pending = true;
			setFailed(false);
			if (math && !selectionText)
				void readerFormulaText({ ...ctx, pageIndex, region: { x, y, w, h } })
					.then((content) => {
						if (!cancelled) setNativeContent(content);
					})
					.catch(() => {});
			try {
				const page = ctx.document.pages[pageIndex];
				const scaleFactor = rasterScale * Math.max(1, window.devicePixelRatio);
				const crop = await readerCropBlob({
					...ctx,
					pageIndex,
					region: { x, y, w, h },
					maxEdgePx:
						mask && page
							? Math.min(
									4096,
									Math.max(
										600,
										Math.ceil(
											Math.max(w * page.size.width, h * page.size.height) *
												scaleFactor,
										),
									),
								)
							: 1400,
					transparentBackground: mask,
					scaleFactor,
				});
				if (!cancelled && visible) {
					release();
					url = URL.createObjectURL(crop);
					imageUrl.current = url;
					setImage(url);
				}
			} catch {
				if (!cancelled && visible) setFailed(true);
			} finally {
				pending = false;
			}
		};
		const element = ref.current;
		const observer = new IntersectionObserver(
			(entries) => {
				visible = entries.some((entry) => entry.isIntersecting);
				if (visible) void load();
				else {
					release();
					setImage(null);
				}
			},
			{ rootMargin: "500px" },
		);
		if (element) observer.observe(element);
		return () => {
			cancelled = true;
			observer.disconnect();
		};
	}, [pageIndex, x, y, w, h, context, mask, rasterScale, math, selectionText]);
	const page = context()?.document.pages[pageIndex];
	const width = page ? Math.max(bbox.w * page.size.width, 1) : undefined;
	const height = page ? Math.max(bbox.h * page.size.height, 1) : undefined;
	return (
		<span
			ref={ref}
			data-reader-start={math && selectable ? 0 : undefined}
			data-reader-end={math && selectable ? selectable.length : undefined}
			data-reader-raster={math && selectable ? "" : undefined}
			className={
				inline ? "relative inline-block" : "relative mx-auto block max-w-full"
			}
			style={{
				...(width && height
					? inline
						? {
								// The crop is measured in PDF points; match the surrounding
								// text's em, independently of raster resolution and zoom.
								width: `${width / inline.fontSize}em`,
								height: `${height / inline.fontSize}em`,
								verticalAlign: `${-inline.baselineOffset / inline.fontSize}em`,
								lineHeight: 0,
							}
						: {
								width: `${(width * displayScale) / 16}rem`,
								aspectRatio: `${width} / ${height}`,
							}
					: undefined),
			}}
		>
			{selectable && (
				<span
					data-reader-crop-text
					data-reader-copy={selectable}
					className="absolute inset-0 z-[1] select-text overflow-hidden text-transparent selection:text-transparent"
					style={{
						fontSize: glyphs?.length ? undefined : "inherit",
						lineHeight: "normal",
						letterSpacing: 0,
						wordSpacing: 0,
					}}
				>
					{glyphs?.length
						? glyphs.map((glyph) => (
								<span
									key={glyph.index}
									className="absolute whitespace-pre leading-none"
									style={{
										left: `${glyph.box.x * 100}%`,
										top: `${glyph.box.y * 100}%`,
										fontSize: inline
											? `${(glyph.box.h * (height ?? 1)) / inline.fontSize}em`
											: `${(glyph.box.h * (height ?? 1) * displayScale) / 16}rem`,
									}}
								>
									{glyph.text}
								</span>
							))
						: selectable}
				</span>
			)}
			{image && mask ? (
				<span
					data-reader-math-mask
					role="img"
					aria-label={label}
					aria-hidden={selectable ? true : undefined}
					className="pointer-events-none absolute inset-0 block"
					style={{
						backgroundColor: "currentColor",
						maskImage: `url("${image}")`,
						maskSize: "100% 100%",
						maskRepeat: "no-repeat",
					}}
				/>
			) : image ? (
				<img
					src={image}
					alt={label}
					className="absolute inset-0 block h-full w-full object-contain"
				/>
			) : (
				<span
					className="absolute inset-0 flex select-none items-center justify-center gap-2 overflow-hidden text-xs opacity-60"
					aria-hidden={selectable ? true : undefined}
				>
					{failed ? (
						<>
							{t("pdf.reading.imageFailed")}
							{inline && ` (${label})`}
						</>
					) : (
						<>
							<Loader2 className="size-3 animate-spin" aria-hidden />
							{label}
						</>
					)}
				</span>
			)}
			{image && page && linkSource && handlers && (
				<CitationLinkLayer
					links={linkSource.citationLinks.get(pageIndex) ?? []}
					textLinks={linkSource.textLinks.get(pageIndex) ?? []}
					pageWidthPt={page.size.width}
					pageHeightPt={page.size.height}
					viewport={{
						origin: { x: x * page.size.width, y: y * page.size.height },
						size: { width: w * page.size.width, height: h * page.size.height },
					}}
					label={t("pdf.linkAria")}
					onActivate={(link) => handlers.onLinkActivate?.(link)}
					onTextActivate={(url) => handlers.onUrlActivate?.(url)}
					onHover={(link, point) => handlers.onLinkHover?.(link, point)}
					onUrlHover={(url, point) => handlers.onUrlHover?.(url, point)}
				/>
			)}
			{children}
		</span>
	);
});

type Props = ReaderLinkHandlers & {
	blocks: ReadingBlock[];
	showTranslations?: boolean;
	settings: ReadingSettings;
	onFontScaleChange?: (scale: number) => void;
	preparing: boolean;
	preparingLayoutBackend?:
		| import("@/lib/pdf/layout/settings").LayoutBackend
		| null;
	error: string | null;
	currentPage: number;
	navigationTarget?: PdfNavigationTarget | null;
	onPageChange: (page: number) => void;
	onShowSource: (block: ReadingBlock) => void;
	onRetry: () => void;
	context: Context;
	linkSource?: Pick<
		TranslatedLinkSource,
		"citationLinks" | "textLinks" | "inkByKey" | "glyphRunsByPage"
	>;
	readerRestore?: JumpOrigin | null;
};
export function PdfContinuousReader({
	blocks,
	showTranslations = true,
	settings,
	onFontScaleChange,
	preparing,
	preparingLayoutBackend,
	error,
	currentPage,
	navigationTarget,
	onPageChange,
	onShowSource,
	onRetry,
	context,
	linkSource,
	onLinkActivate,
	onLinkHover,
	onUrlActivate,
	onUrlHover,
	readerRestore,
}: Props) {
	const { t } = useTranslation(["viewer", "settings"]);
	const rootRef = useRef<HTMLDivElement>(null);
	const progressAnchor = useRef<ReturnType<typeof visibleReaderAnchor>>(null);
	const previousPreparation = useRef({
		blocks,
		preparing,
		navigationTarget,
		readerRestore,
	});
	useLayoutEffect(() => {
		const prior = previousPreparation.current;
		const root = rootRef.current;
		const anchor = progressAnchor.current;
		if (
			root &&
			anchor?.element.isConnected &&
			prior.preparing &&
			prior.blocks !== blocks &&
			prior.navigationTarget === navigationTarget &&
			prior.readerRestore === readerRestore
		) {
			root.scrollTop +=
				anchor.element.getBoundingClientRect().top -
				root.getBoundingClientRect().top -
				anchor.top;
		}
		previousPreparation.current = {
			blocks,
			preparing,
			navigationTarget,
			readerRestore,
		};
		progressAnchor.current = preparing ? visibleReaderAnchor(root) : null;
	}, [blocks, preparing, navigationTarget, readerRestore]);
	const pages = context()?.document.pages;

	const linksByBlock = useMemo(() => {
		const result = new Map<string, ReaderPageLinks>();
		if (!linkSource || !pages) return result;
		const byPage = new Map<number, ReadingBlock[]>();
		for (const block of blocks) {
			if (block.image) continue;
			const list = byPage.get(block.pageIndex) ?? [];
			list.push(block);
			byPage.set(block.pageIndex, list);
		}
		for (const [pageIndex, onPage] of byPage) {
			const size = pages[pageIndex]?.size;
			if (!size) continue;
			const boxes: TranslateLinkBox[] = [];
			const native = linkSource.citationLinks.get(pageIndex) ?? [];
			const byId = new Map(native.map((link) => [link.id, link]));
			for (const link of [
				...native.map((link) => ({
					key: link.id,
					url: linkTargetUrl(link.target),
					rect: link.rect,
				})),
				...(linkSource.textLinks.get(pageIndex) ?? []).map((link) => ({
					...link,
					key: translatedTextLinkKey(link),
				})),
			]) {
				boxes.push({
					key: link.key,
					kind: link.url ? "url" : "goto",
					url: link.url ?? undefined,
					box: {
						x: link.rect.origin.x / size.width,
						y: link.rect.origin.y / size.height,
						w: link.rect.size.width / size.width,
						h: link.rect.size.height / size.height,
					},
					color: linkSource.inkByKey.get(link.key),
				});
			}
			const claimed = claimTranslateLinks(onPage, boxes);
			for (const block of onPage)
				result.set(block.id, {
					boxes: claimed.get(block.id) ?? [],
					byId,
					runs: linkSource.glyphRunsByPage.get(pageIndex),
				});
		}
		return result;
	}, [blocks, linkSource, pages]);
	const text = (block: ReadingBlock, translated = false) => {
		const page = pages?.[block.pageIndex];
		return (
			<ReaderText
				block={block}
				translated={translated}
				pageSize={page?.size}
				settings={settings}
				links={linksByBlock.get(block.id)}
				handlers={{ onLinkActivate, onLinkHover, onUrlActivate, onUrlHover }}
				renderFormula={(formula, baselineOffset) =>
					page && (
						<ReaderCrop
							pageIndex={block.pageIndex}
							bbox={{
								x: formula.box.x / page.size.width,
								y: formula.box.y / page.size.height,
								w: formula.box.w / page.size.width,
								h: formula.box.h / page.size.height,
							}}
							label={formula.text}
							selectionText={formula.text}
							selectionGlyphs={block.item?.reflow?.characters
								.filter((c) => formula.characterIndexes.includes(c.index))
								.map((c) => ({
									index: c.index,
									text: c.text,
									box: {
										x: (c.visualBox.x - formula.box.x) / formula.box.w,
										y: (c.visualBox.y - formula.box.y) / formula.box.h,
										w: c.visualBox.w / formula.box.w,
										h: c.visualBox.h / formula.box.h,
									},
								}))}
							context={context}
							inline={{
								fontSize: block.item?.reflow?.style.size ?? 10,
								fontScale: settings.fontScale,
								baselineOffset,
							}}
						/>
					)
				}
			/>
		);
	};
	const [fontScale, setFontScale] = useState(settings.fontScale);
	const fontScaleRef = useRef(fontScale);
	fontScaleRef.current = fontScale;
	const zoomCallback = useRef(onFontScaleChange);
	zoomCallback.current = onFontScaleChange;
	const zoomAnchor = useRef<{ element: Element; top: number } | null>(null);
	useEffect(() => setFontScale(settings.fontScale), [settings.fontScale]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Restore the pointer's paragraph after each font-size layout.
	useLayoutEffect(() => {
		const anchor = zoomAnchor.current;
		if (anchor && rootRef.current)
			rootRef.current.scrollTop +=
				anchor.element.getBoundingClientRect().top - anchor.top;
		zoomAnchor.current = null;
	}, [fontScale]);
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		let saveTimer: ReturnType<typeof setTimeout> | undefined;
		const wheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			event.stopPropagation();
			const element = document
				.elementFromPoint?.(event.clientX, event.clientY)
				?.closest("[data-reader-block]");
			zoomAnchor.current =
				element && root.contains(element)
					? { element, top: element.getBoundingClientRect().top }
					: null;
			const delta =
				event.deltaY *
				(event.deltaMode === 1
					? 16
					: event.deltaMode === 2
						? root.clientHeight
						: 1);
			const next = normalizeReadingSettings({
				fontScale: fontScaleRef.current * wheelDeltaToZoomRatio(delta),
			}).fontScale;
			fontScaleRef.current = next;
			setFontScale(next);
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => zoomCallback.current?.(next), 180);
		};
		root.addEventListener("wheel", wheel, { passive: false });
		return () => {
			root.removeEventListener("wheel", wheel);
			clearTimeout(saveTimer);
		};
	}, []);
	const visiblePage = useRef<number | null>(null);
	const scrollingFromPdf = useRef(false);
	const handledReaderRestore = useRef(readerRestore);
	// Requests that predate this reader session were already applied to the PDF.
	const handledNavigation = useRef<PdfNavigationTarget | null>(
		navigationTarget ?? null,
	);
	useEffect(() => {
		const root = rootRef.current;
		if (!root || !blocks.length) return;
		if (
			readerRestore &&
			readerRestore !== handledReaderRestore.current &&
			readerRestore.reader
		) {
			handledReaderRestore.current = readerRestore;
			handledNavigation.current = navigationTarget ?? null;
			scrollingFromPdf.current = true;
			const origin = readerRestore.reader;
			const block = origin.blockId
				? root.querySelector<HTMLElement>(
						`[data-reader-block="${CSS.escape(origin.blockId)}"]`,
					)
				: null;
			root.scrollTop = block
				? root.scrollTop +
					block.getBoundingClientRect().top -
					root.getBoundingClientRect().top -
					origin.top
				: origin.scrollTop;
			visiblePage.current = readerRestore.page;
			progressAnchor.current = preparing ? visibleReaderAnchor(root) : null;
			const frame = requestAnimationFrame(() => {
				scrollingFromPdf.current = false;
			});
			return () => {
				cancelAnimationFrame(frame);
				scrollingFromPdf.current = false;
			};
		}
		const requested =
			navigationTarget && navigationTarget !== handledNavigation.current;
		if (!requested && currentPage === visiblePage.current) return;
		const page = requested ? navigationTarget.page : currentPage;
		const region = requested ? navigationTarget.region : undefined;
		let nearest: ReadingBlock | undefined;
		let distance = Number.POSITIVE_INFINITY;
		if (region) {
			for (const block of blocks) {
				if (block.pageIndex !== page - 1) continue;
				if (block.id === region.id) {
					nearest = block;
					break;
				}
				const candidate =
					Math.abs(block.bbox.y - region.bbox.y) +
					Math.abs(block.bbox.x - region.bbox.x);
				if (candidate < distance) {
					nearest = block;
					distance = candidate;
				}
			}
		}
		const target =
			(nearest &&
				root.querySelector<HTMLElement>(
					`[data-reader-block="${CSS.escape(nearest.id)}"]`,
				)) ||
			root.querySelector<HTMLElement>(`[data-reader-page="${page}"]`) ||
			Array.from(root.querySelectorAll<HTMLElement>("[data-reader-page]")).find(
				(element) => Number(element.dataset.readerPage) >= page,
			);
		if (target) {
			handledNavigation.current = navigationTarget ?? null;
			scrollingFromPdf.current = true;
			root.scrollTop +=
				target.getBoundingClientRect().top -
				root.getBoundingClientRect().top -
				48;
			visiblePage.current = page;
			progressAnchor.current = preparing ? visibleReaderAnchor(root) : null;
			const frame = requestAnimationFrame(() => {
				scrollingFromPdf.current = false;
			});
			return () => {
				cancelAnimationFrame(frame);
				scrollingFromPdf.current = false;
			};
		}
	}, [currentPage, blocks, navigationTarget, readerRestore, preparing]);
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const handleKey = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey
			)
				return;
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest(
					"input, textarea, button, a, [contenteditable='true'], [role='dialog'], [role='slider'], [data-pdf-chrome]",
				)
			)
				return;
			if (!root.matches(":hover") && !root.contains(document.activeElement))
				return;
			let top: number;
			switch (event.key) {
				case "ArrowUp":
					top = root.scrollTop - 72;
					break;
				case "ArrowDown":
					top = root.scrollTop + 72;
					break;
				case "PageUp":
					top = root.scrollTop - root.clientHeight * 0.9;
					break;
				case "PageDown":
					top = root.scrollTop + root.clientHeight * 0.9;
					break;
				case " ":
					top =
						root.scrollTop + root.clientHeight * (event.shiftKey ? -0.9 : 0.9);
					break;
				case "Home":
					top = 0;
					break;
				case "End":
					top = root.scrollHeight;
					break;
				default:
					return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			root.scrollTop = top;
		};
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, []);
	return (
		<ScrollAreaPrimitive.Root
			type="always"
			className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden"
			style={readingColors(settings)}
		>
			<ScrollAreaPrimitive.Viewport
				ref={rootRef}
				data-pdf-reader
				tabIndex={0}
				aria-label={t("pdf.reading.title")}
				aria-busy={preparing}
				onPointerDownCapture={(event) => {
					if (event.button === 0) beginLinkPreviewDrag();
				}}
				className="agentero-scroll agentero-scroll-visible h-full min-h-0 min-w-0 select-text pr-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>div]:block!"
				style={{ ...readingColors(settings), scrollbarGutter: "stable" }}
				onPointerDown={(event) => {
					if (
						event.target instanceof Element &&
						!event.target.closest("button, a, input")
					)
						event.currentTarget.focus({ preventScroll: true });
				}}
				onScroll={() => {
					const root = rootRef.current;
					progressAnchor.current = preparing ? visibleReaderAnchor(root) : null;
					if (!root || scrollingFromPdf.current) return;
					const top = root.getBoundingClientRect().top + 64;
					const elements =
						root.querySelectorAll<HTMLElement>("[data-reader-page]");
					const last = elements[elements.length - 1];
					const atBottom =
						root.scrollTop > 0 &&
						root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
					let page = elements.length
						? Number(elements[0].dataset.readerPage)
						: currentPage;
					if (atBottom && last) page = Number(last.dataset.readerPage);
					else
						for (const element of elements) {
							if (element.getBoundingClientRect().top > top) break;
							page = Number(element.dataset.readerPage);
						}
					if (page !== visiblePage.current) {
						visiblePage.current = page;
						onPageChange(page);
					}
				}}
			>
				<article
					className="mx-auto space-y-5 pt-14 pb-24 font-serif text-base"
					style={{
						width: `${settings.pageWidth}%`,
						fontSize: `${fontScale}rem`,
						maxWidth: "calc(100% - 3.5rem)",
						lineHeight: settings.lineHeight,
						wordSpacing: `${settings.wordSpacing / 100}em`,
						letterSpacing: `${settings.characterSpacing / 100}em`,
						overflowWrap: "anywhere",
					}}
				>
					{preparing && (
						<p
							role="status"
							className="flex items-center gap-2 font-sans text-sm opacity-65"
						>
							<Loader2 className="size-4 animate-spin" aria-hidden />
							{preparingLayoutBackend
								? t("pdf.reading.preparingLayout", {
										provider: t(
											`settings:layout.backend.${preparingLayoutBackend}`,
										),
									})
								: t("pdf.reading.preparing")}
						</p>
					)}
					{error && (
						<div className="space-y-2 font-sans text-sm">
							<p>{t("pdf.reading.failed")}</p>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={onRetry}
							>
								{t("pdf.reading.retry")}
							</Button>
						</div>
					)}
					{!preparing && !error && !blocks.length && (
						<p className="font-sans text-sm opacity-65">
							{t("pdf.reading.empty")}
						</p>
					)}
					{blocks.map((block) => (
						<section
							key={block.id}
							data-reader-block={block.id}
							data-reader-page={block.pageIndex + 1}
							data-reader-bbox={`${block.bbox.x},${block.bbox.y},${block.bbox.w},${block.bbox.h}`}
							className="group relative"
						>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								className="absolute -left-7 top-0 opacity-0 group-hover:opacity-70 focus-visible:opacity-100"
								aria-label={t("pdf.reading.showSource", {
									page: block.pageIndex + 1,
								})}
								title={t("pdf.reading.showSource", {
									page: block.pageIndex + 1,
								})}
								onClick={() => onShowSource(block)}
							>
								<LocateFixed className="size-3.5" aria-hidden />
							</Button>
							{block.image ? (
								<figure
									data-reader-text-root={
										block.kind === "formula" || block.kind === "formula_number"
											? ""
											: undefined
									}
								>
									<ReaderEquation
										source={block.source}
										fallback={
											<ReaderCrop
												pageIndex={block.pageIndex}
												bbox={block.bbox}
												label={t(layoutKindI18nKey(block.kind))}
												selectionText={block.source}
												displayFontScale={fontScale}
												context={context}
												linkSource={linkSource}
												handlers={{
													onLinkActivate,
													onLinkHover,
													onUrlActivate,
													onUrlHover,
												}}
												math={
													block.kind === "formula" ||
													block.kind === "formula_number"
												}
											></ReaderCrop>
										}
									/>
								</figure>
							) : (
								<>
									{block.kind === "header" ? (
										<h2
											data-reader-text-root
											className="font-semibold text-[1.25em]"
										>
											{text(block)}
										</h2>
									) : (
										<p
											data-reader-text-root
											className={
												block.kind === "figure_title"
													? "text-[0.9em]"
													: undefined
											}
										>
											{text(block)}
										</p>
									)}
									{showTranslations && block.translated && (
										<p
											data-reader-translation
											data-reader-text-root
											className="mt-3 border-l-2 border-current/20 pl-4 opacity-80"
										>
											{text(block, true)}
										</p>
									)}
								</>
							)}
						</section>
					))}
				</article>
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar className="z-10 [&>[data-slot=scroll-area-thumb]]:bg-current/30" />
		</ScrollAreaPrimitive.Root>
	);
}
