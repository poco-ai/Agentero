import {
	Boxes,
	ChevronRight,
	Eye,
	EyeOff,
	ImageIcon,
	Loader2,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";

import { PaneHeader } from "@/components/shell/pane-header";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PromptImage } from "@/lib/agent";
import { cn } from "@/lib/core/utils";
import {
	compareLayoutReadingOrder,
	dedupeLayoutRegions,
	formulaSortAnchor,
	isAlgorithmLayoutKind,
	isFigureLayoutKind,
	isFormulaLayoutKind,
	isSidebarLayoutKind,
	isTableLayoutKind,
	LAYOUT_SIDEBAR_MIN_SCORE,
	layoutAnalysisStore,
	type PdfLayoutKind,
	type PdfLayoutRegion,
	toggleLayoutOverlayVisible,
} from "@/lib/pdf/layout";

type FiguresPanelProps = {
	/** EmbedPDF documentId / PDF tab id used as layout store key. */
	documentId: string | null;
	/** Whether a PDF viewer handle is currently registered for this doc. */
	viewerReady: boolean;
	/** Layout analysis in progress (from toolbar / handle). */
	analyzing?: boolean;
	onAnalyze: () => void;
	onJump: (region: PdfLayoutRegion) => void;
	/** Crop a region for sidebar thumbnails (null when viewer unavailable). */
	onRenderThumb?: (region: PdfLayoutRegion) => Promise<PromptImage | null>;
	className?: string;
};

type SidebarKind = "image" | "chart" | "table" | "algorithm" | "formula";

function asSidebarKind(kind: PdfLayoutKind): SidebarKind | null {
	if (kind === "image" || kind === "chart") return kind;
	if (isTableLayoutKind(kind)) return "table";
	if (isAlgorithmLayoutKind(kind)) return "algorithm";
	if (isFormulaLayoutKind(kind)) return "formula";
	return null;
}

function FigureCard({
	region,
	index,
	selected,
	thumb,
	onJump,
}: {
	region: PdfLayoutRegion;
	index: number;
	selected: boolean;
	thumb: PromptImage | null | undefined;
	onJump: (region: PdfLayoutRegion) => void;
}) {
	const { t } = useTranslation("viewer");
	const page = region.pageIndex + 1;
	const kind = asSidebarKind(region.kind);
	if (!kind) return null;

	const fallbackTitle =
		kind === "table"
			? t("figures.tableItem", { n: index })
			: kind === "algorithm"
				? t("figures.algorithmItem", { n: index })
				: kind === "formula"
					? t("figures.formulaItem", { n: index })
					: kind === "chart"
						? t("figures.chartItem", { n: index })
						: t("figures.figureItem", { n: index });
	// Prefer PDF caption text for figures/tables; formulas have no number parse.
	const caption = region.title?.trim() || "";
	const title = caption || fallbackTitle;

	// Formulas are wide one-line crops — 4:3 wastes vertical space.
	const isFormula = kind === "formula";

	return (
		<button
			type="button"
			data-layout-region={region.id}
			className={cn(
				"group flex w-full flex-col overflow-hidden rounded-md border border-border/80 bg-background text-left transition-colors",
				"hover:bg-muted/30",
				selected && "border-foreground/40 ring-1 ring-foreground/20",
			)}
			onClick={() => onJump(region)}
		>
			<div
				className={cn(
					"relative flex w-full items-center justify-center overflow-hidden bg-muted/20",
					// Formulas: short strip (~3:1), not figure-style 4:3.
					isFormula ? "aspect-[3/1] max-h-20" : "aspect-[4/3]",
				)}
			>
				<span
					className={cn(
						"absolute z-10 rounded bg-background/80 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground backdrop-blur-sm",
						isFormula ? "top-1 right-1" : "top-1.5 right-1.5",
					)}
				>
					{t("figures.page", { page })}
				</span>
				{thumb ? (
					<img
						src={`data:${thumb.mimeType};base64,${thumb.data}`}
						alt=""
						className={cn(
							"max-h-full max-w-full object-contain",
							isFormula && "w-full object-left",
						)}
						draggable={false}
					/>
				) : (
					<div className="flex flex-col items-center gap-1 text-muted-foreground">
						<ImageIcon
							className={cn("opacity-60", isFormula ? "size-4" : "size-6")}
							aria-hidden
						/>
						<span className="text-[10px]">{t("figures.thumbPending")}</span>
					</div>
				)}
			</div>
			<div className={cn("px-2", isFormula ? "py-1" : "py-1.5")}>
				<p
					className={cn(
						"font-medium text-xs",
						caption ? "line-clamp-2" : "truncate",
					)}
					title={title}
				>
					{title}
				</p>
			</div>
		</button>
	);
}

function Section({
	title,
	count,
	children,
}: {
	title: string;
	count: number;
	children: ReactNode;
}) {
	const { t } = useTranslation("viewer");
	const [open, setOpen] = useState(true);

	if (count === 0) return null;

	return (
		<section className="space-y-2">
			<button
				type="button"
				className={cn(
					"flex w-full items-center justify-between gap-1 rounded px-0.5 py-0.5 text-left transition-colors",
					"text-muted-foreground hover:bg-muted/40 hover:text-foreground",
				)}
				aria-expanded={open}
				aria-label={
					open
						? t("figures.collapseSection", { title })
						: t("figures.expandSection", { title })
				}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="flex min-w-0 items-center gap-1 font-medium text-xs uppercase tracking-wide">
					<ChevronRight
						className={cn(
							"size-3 shrink-0 transition-transform",
							open && "rotate-90",
						)}
						aria-hidden
					/>
					<span className="truncate">{title}</span>
				</span>
				<span className="shrink-0 text-[10px] tabular-nums opacity-80">
					{count}
				</span>
			</button>
			{open ? <div className="grid grid-cols-1 gap-2">{children}</div> : null}
		</section>
	);
}

/**
 * Right-rail gallery: figures / tables / algorithms / numbered formulas.
 * Formulas section is always last. Unnumbered formulas are already dropped
 * at merge time. Fixed confidence gate + NMS-dedupe (no slider).
 */
export function FiguresPanel({
	documentId,
	viewerReady,
	analyzing = false,
	onAnalyze,
	onJump,
	onRenderThumb,
	className,
}: FiguresPanelProps) {
	const { t } = useTranslation("viewer");
	const result = useStore(layoutAnalysisStore, (s) =>
		documentId ? (s.byDocument[documentId] ?? null) : null,
	);
	const focusedId = useStore(layoutAnalysisStore, (s) =>
		documentId && s.focused?.documentId === documentId
			? s.focused.regionId
			: null,
	);
	const ui = useStore(layoutAnalysisStore, (s) => s.ui);
	const [thumbs, setThumbs] = useState<Record<string, PromptImage | null>>({});

	const gallery = useMemo(() => {
		const sidebarOnly = (result?.regions ?? []).filter((r) =>
			isSidebarLayoutKind(r.kind),
		);
		return dedupeLayoutRegions(sidebarOnly, {
			minScore: LAYOUT_SIDEBAR_MIN_SCORE,
		});
	}, [result]);

	const figures = useMemo(
		() => gallery.filter((r) => isFigureLayoutKind(r.kind)),
		[gallery],
	);
	const tables = useMemo(
		() => gallery.filter((r) => isTableLayoutKind(r.kind)),
		[gallery],
	);
	const algorithms = useMemo(
		() => gallery.filter((r) => isAlgorithmLayoutKind(r.kind)),
		[gallery],
	);
	const formulas = useMemo(() => {
		// Page → left column → right column → top→bottom (eq number order).
		const list = gallery.filter((r) => isFormulaLayoutKind(r.kind));
		return [...list].sort((a, b) =>
			compareLayoutReadingOrder(a, b, formulaSortAnchor),
		);
	}, [gallery]);

	const rawSidebarCount = useMemo(
		() =>
			(result?.regions ?? []).filter((r) => isSidebarLayoutKind(r.kind)).length,
		[result],
	);
	/** Eye toggle needs any stored detections (prefer pre-merge raw). */
	const hasOverlaySource = useMemo(
		() =>
			(result?.rawRegions?.length ?? 0) > 0 ||
			(result?.regions?.length ?? 0) > 0,
		[result],
	);

	// Lazy thumbnails — sequential-ish batches to avoid PDFium thrash.
	useEffect(() => {
		if (!documentId || !onRenderThumb || gallery.length === 0) {
			setThumbs({});
			return;
		}
		let cancelled = false;
		const ids = new Set(gallery.map((r) => r.id));
		setThumbs((prev) => {
			const next: Record<string, PromptImage | null> = {};
			for (const id of Object.keys(prev)) {
				if (ids.has(id)) next[id] = prev[id];
			}
			return next;
		});

		void (async () => {
			const concurrency = 2;
			let cursor = 0;
			const workers = Array.from(
				{ length: Math.min(concurrency, gallery.length) },
				async () => {
					while (!cancelled) {
						const index = cursor;
						cursor += 1;
						if (index >= gallery.length) return;
						const region = gallery[index];
						if (!region) return;
						try {
							const image = await onRenderThumb(region);
							if (cancelled) return;
							setThumbs((prev) =>
								prev[region.id] === image
									? prev
									: { ...prev, [region.id]: image },
							);
						} catch {
							if (cancelled) return;
							setThumbs((prev) =>
								prev[region.id] === null
									? prev
									: { ...prev, [region.id]: null },
							);
						}
					}
				},
			);
			await Promise.all(workers);
		})();

		return () => {
			cancelled = true;
		};
	}, [documentId, gallery, onRenderThumb]);

	useEffect(() => {
		if (!focusedId) return;
		document
			.querySelector(`[data-layout-region="${CSS.escape(focusedId)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [focusedId]);

	const handleJump = useCallback(
		(region: PdfLayoutRegion) => {
			onJump(region);
		},
		[onJump],
	);

	const overlayVisible = useStore(layoutAnalysisStore, (s) =>
		documentId ? (s.overlayVisible[documentId] ?? false) : false,
	);

	const running =
		analyzing ||
		(ui.stage === "running" &&
			(!documentId ||
				layoutAnalysisStore.getState().activeDocumentId === documentId));

	const empty = gallery.length === 0;
	const hasRaw = rawSidebarCount > 0;

	const analysisProgress =
		ui.stage === "running" && typeof ui.progress === "number"
			? ui.progress
			: null;
	const analysisPageTotal =
		ui.stage === "running" && typeof ui.total === "number" && ui.total > 0
			? ui.total
			: null;
	const analysisPageCurrent =
		ui.stage === "running" && typeof ui.page === "number" && ui.page > 0
			? ui.page
			: ui.stage === "running" && typeof ui.completed === "number"
				? ui.completed
				: null;

	const analyzeTooltip =
		ui.stage === "running"
			? ui.message
			: ui.stage === "error"
				? ui.message
				: result
					? t("figures.reanalyze")
					: t("figures.analyze");

	const handleToggleOverlay = useCallback(() => {
		if (!documentId) return;
		toggleLayoutOverlayVisible(documentId);
	}, [documentId]);

	return (
		<section
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden bg-background",
				className,
			)}
			aria-label={t("figures.panelAria")}
		>
			<PaneHeader
				trailing={
					documentId && viewerReady ? (
						<TooltipProvider delayDuration={200}>
							<div className="flex items-center gap-0.5">
								{hasOverlaySource ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant={overlayVisible ? "secondary" : "ghost"}
												size="icon-xs"
												className={cn(
													"size-6 text-muted-foreground hover:text-foreground",
													overlayVisible && "text-primary",
												)}
												aria-label={t("figures.toggleOverlay")}
												aria-pressed={overlayVisible}
												onClick={handleToggleOverlay}
											>
												{overlayVisible ? (
													<Eye className="size-3.5" aria-hidden />
												) : (
													<EyeOff className="size-3.5" aria-hidden />
												)}
											</Button>
										</TooltipTrigger>
										<TooltipContent side="bottom" className="max-w-52 text-xs">
											{overlayVisible
												? t("figures.hideOverlay")
												: t("figures.showOverlay")}
										</TooltipContent>
									</Tooltip>
								) : null}
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant={running ? "secondary" : "ghost"}
											size="icon-xs"
											className="size-6 text-muted-foreground hover:text-foreground"
											aria-label={
												result ? t("figures.reanalyze") : t("figures.analyze")
											}
											aria-busy={running}
											disabled={running}
											onClick={onAnalyze}
										>
											{running ? (
												<Loader2
													className="size-3.5 animate-spin"
													aria-hidden
												/>
											) : (
												<Boxes className="size-3.5" aria-hidden />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom" className="max-w-64 text-xs">
										{analyzeTooltip}
									</TooltipContent>
								</Tooltip>
							</div>
						</TooltipProvider>
					) : null
				}
			>
				<ImageIcon className="size-4 text-muted-foreground" aria-hidden />
				<span className="font-medium text-sm">{t("figures.title")}</span>
			</PaneHeader>

			{!documentId ? (
				<p className="px-3 py-8 text-center text-muted-foreground text-xs">
					{t("figures.noPaper")}
				</p>
			) : running && !hasRaw ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4">
					<div className="w-full max-w-[14rem] space-y-2">
						<p className="text-center text-muted-foreground text-xs">
							{ui.stage === "running" ? ui.message : t("figures.analyzing")}
						</p>
						<Progress
							value={analysisProgress ?? undefined}
							aria-label={
								ui.stage === "running" ? ui.message : t("figures.analyzing")
							}
							className={cn(
								"h-1.5",
								analysisProgress == null && "animate-pulse opacity-70",
							)}
						/>
						{analysisProgress != null || analysisPageTotal != null ? (
							<p className="text-center text-[10px] text-muted-foreground tabular-nums">
								{analysisPageTotal != null && analysisPageCurrent != null
									? t("figures.progressPages", {
											page: analysisPageCurrent,
											total: analysisPageTotal,
										})
									: t("figures.progressPct", {
											pct: analysisProgress ?? 0,
										})}
							</p>
						) : null}
					</div>
				</div>
			) : !hasRaw ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4">
					<p className="text-center text-muted-foreground text-xs">
						{viewerReady ? t("figures.empty") : t("figures.viewerUnavailable")}
					</p>
					{viewerReady ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={running}
							onClick={onAnalyze}
						>
							{running ? (
								<Loader2 className="size-3.5 animate-spin" aria-hidden />
							) : null}
							{t("figures.analyze")}
						</Button>
					) : null}
				</div>
			) : empty ? (
				<p className="px-3 py-8 text-center text-muted-foreground text-xs">
					{t("figures.emptyFiltered")}
				</p>
			) : (
				<div className="agentero-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
					<Section title={t("figures.sectionFigures")} count={figures.length}>
						{figures.map((region, i) => (
							<FigureCard
								key={region.id}
								region={region}
								index={i + 1}
								selected={focusedId === region.id}
								thumb={thumbs[region.id]}
								onJump={handleJump}
							/>
						))}
					</Section>
					<Section title={t("figures.sectionTables")} count={tables.length}>
						{tables.map((region, i) => (
							<FigureCard
								key={region.id}
								region={region}
								index={i + 1}
								selected={focusedId === region.id}
								thumb={thumbs[region.id]}
								onJump={handleJump}
							/>
						))}
					</Section>
					<Section
						title={t("figures.sectionAlgorithms")}
						count={algorithms.length}
					>
						{algorithms.map((region, i) => (
							<FigureCard
								key={region.id}
								region={region}
								index={i + 1}
								selected={focusedId === region.id}
								thumb={thumbs[region.id]}
								onJump={handleJump}
							/>
						))}
					</Section>
					{/* Formulas always last: numbered only (merge drops unnumbered). */}
					<Section title={t("figures.sectionFormulas")} count={formulas.length}>
						{formulas.map((region, i) => (
							<FigureCard
								key={region.id}
								region={region}
								index={i + 1}
								selected={focusedId === region.id}
								thumb={thumbs[region.id]}
								onJump={handleJump}
							/>
						))}
					</Section>
				</div>
			)}
		</section>
	);
}
