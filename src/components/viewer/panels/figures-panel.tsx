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
import { QuietIconButton } from "@/components/ui/quiet-icon-button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PromptImage } from "@/lib/agent";
import { backgroundTasksStore } from "@/lib/core/background-tasks";
import { sameRelPaperPath } from "@/lib/core/path";
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
	layoutDocumentKey,
	normalizeLayoutPaperKey,
	type PdfLayoutKind,
	type PdfLayoutRegion,
	toggleLayoutOverlayVisible,
} from "@/lib/pdf/layout";

type FiguresPanelProps = {
	/** EmbedPDF documentId / PDF tab id used as layout store key. */
	documentId: string | null;
	/** Paper folder abs path — matches headless layoutAnalyze progress. */
	paperAbsPath?: string | null;
	/** Vault-relative paper path — matches JobCenter projected task rows. */
	paperRelPath?: string | null;
	/** Whether a PDF viewer handle is currently registered for this doc. */
	viewerReady: boolean;
	/** Layout analysis in progress (from toolbar / handle). */
	analyzing?: boolean;
	onAnalyze: () => void;
	onJump: (region: PdfLayoutRegion) => void;
	/** Crop a region for sidebar thumbnails (null when viewer unavailable). */
	onRenderThumb?: (region: PdfLayoutRegion) => Promise<PromptImage | null>;
	className?: string;
	/** Hide the pane header for use inside a floating PDF panel. */
	compact?: boolean;
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
						"absolute z-10 rounded bg-background/80 px-1.5 py-0.5 text-caption tabular-nums text-muted-foreground backdrop-blur-sm",
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
						<span className="text-caption">{t("figures.thumbPending")}</span>
					</div>
				)}
			</div>
			<div className={cn("px-2", isFormula ? "py-1" : "py-1.5")}>
				<p
					className={cn(
						"font-medium text-sm",
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
				<span className="flex min-w-0 items-center gap-1 font-medium text-sm uppercase tracking-wide">
					<ChevronRight
						className={cn(
							"size-3 shrink-0 transition-transform",
							open && "rotate-90",
						)}
						aria-hidden
					/>
					<span className="truncate">{title}</span>
				</span>
				<span className="shrink-0 text-caption tabular-nums opacity-80">
					{count}
				</span>
			</button>
			{open ? <div className="grid grid-cols-1 gap-2">{children}</div> : null}
		</section>
	);
}

/** Eye / EyeOff toggle for the raw layout bbox overlay on the PDF. */
function OverlayToggleButton({
	visible,
	onToggle,
}: {
	visible: boolean;
	onToggle: () => void;
}) {
	const { t } = useTranslation("viewer");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<QuietIconButton
					variant={visible ? "secondary" : "ghost"}
					className={cn(visible && "text-primary")}
					aria-label={t("figures.toggleOverlay")}
					aria-pressed={visible}
					onClick={onToggle}
				>
					{visible ? (
						<Eye className="size-3.5" aria-hidden />
					) : (
						<EyeOff className="size-3.5" aria-hidden />
					)}
				</QuietIconButton>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-52 text-xs">
				{visible ? t("figures.hideOverlay") : t("figures.showOverlay")}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * Self-contained overlay toggle: reads the layout store and renders nothing
 * until the document has detections. `className` supplies the wrapper
 * material/position so callers can slot it into their own chrome (e.g. the
 * compact PDF panel chip that shares the left toolbar's row).
 */
export function FiguresOverlayToggle({
	documentId,
	className,
}: {
	documentId: string;
	className?: string;
}) {
	const result = useStore(
		layoutAnalysisStore,
		(s) => s.byDocument[layoutDocumentKey(documentId)] ?? null,
	);
	const visible = useStore(layoutAnalysisStore, (s) =>
		Boolean(s.overlayVisible[documentId]),
	);
	const hasOverlaySource =
		(result?.rawRegions?.length ?? 0) > 0 || (result?.regions?.length ?? 0) > 0;
	const handleToggle = useCallback(() => {
		toggleLayoutOverlayVisible(documentId);
	}, [documentId]);

	if (!hasOverlaySource) return null;

	return (
		<div className={className}>
			<TooltipProvider delayDuration={200}>
				<OverlayToggleButton visible={visible} onToggle={handleToggle} />
			</TooltipProvider>
		</div>
	);
}

/**
 * Right-rail gallery: figures / tables / algorithms / numbered formulas.
 * Formulas section is always last. Unnumbered formulas are already dropped
 * at merge time. Fixed confidence gate + NMS-dedupe (no slider).
 */
export function FiguresPanel({
	documentId,
	paperAbsPath = null,
	paperRelPath = null,
	viewerReady,
	analyzing = false,
	onAnalyze,
	onJump,
	onRenderThumb,
	className,
	compact,
}: FiguresPanelProps) {
	const { t } = useTranslation("viewer");
	// byDocument is keyed by the revision-stripped base id (bytes-backed
	// viewers mount as `tab::r<n>`); focused/overlay stay raw form.
	const documentKey = documentId ? layoutDocumentKey(documentId) : null;
	const result = useStore(layoutAnalysisStore, (s) =>
		documentKey ? (s.byDocument[documentKey] ?? null) : null,
	);
	const focusedId = useStore(layoutAnalysisStore, (s) =>
		documentId && s.focused?.documentId === documentId
			? s.focused.regionId
			: null,
	);
	const ui = useStore(layoutAnalysisStore, (s) => s.ui);
	const activeDocumentId = useStore(
		layoutAnalysisStore,
		(s) => s.activeDocumentId,
	);
	const activePaperAbsPath = useStore(
		layoutAnalysisStore,
		(s) => s.activePaperAbsPath,
	);
	const layoutJobPending = useStore(backgroundTasksStore, (s) =>
		s.tasks.some(
			(task) =>
				(task.kind === "layoutAnalyze" || task.kind === "layoutRun") &&
				(task.status === "queued" || task.status === "running") &&
				sameRelPaperPath(task.paperPath, paperRelPath),
		),
	);
	const layoutJobQueued = useStore(backgroundTasksStore, (s) =>
		s.tasks.some(
			(task) =>
				task.kind === "layoutAnalyze" &&
				task.status === "queued" &&
				sameRelPaperPath(task.paperPath, paperRelPath),
		),
	);
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

	const paperKey = paperAbsPath ? normalizeLayoutPaperKey(paperAbsPath) : null;
	const storeRunningForPaper =
		ui.stage === "running" &&
		(Boolean(documentId && activeDocumentId === documentId) ||
			Boolean(paperKey && activePaperAbsPath === paperKey) ||
			// Loose PDF / no paper folder: only documentId can attribute the run.
			(!documentId && !paperKey));
	const runningUi = storeRunningForPaper ? ui : null;
	const running = analyzing || runningUi != null || layoutJobPending;

	const empty = gallery.length === 0;
	const hasRaw = rawSidebarCount > 0;

	const analysisProgress =
		runningUi && typeof runningUi.progress === "number"
			? runningUi.progress
			: null;
	const analysisPageTotal =
		runningUi && typeof runningUi.total === "number" && runningUi.total > 0
			? runningUi.total
			: null;
	const analysisPageCurrent =
		runningUi && typeof runningUi.page === "number" && runningUi.page > 0
			? runningUi.page
			: runningUi && typeof runningUi.completed === "number"
				? runningUi.completed
				: null;
	const analysisMessage = runningUi?.message?.trim()
		? runningUi.message
		: layoutJobQueued
			? t("figures.queued")
			: t("figures.analyzing");
	const analysisProgressLabel =
		analysisPageTotal != null && analysisPageCurrent != null
			? t("figures.progressPages", {
					page: analysisPageCurrent,
					total: analysisPageTotal,
				})
			: analysisProgress != null
				? t("figures.progressPct", { pct: Math.round(analysisProgress) })
				: null;

	const analyzeTooltip = running
		? analysisMessage
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
			className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}
			aria-label={t("figures.panelAria")}
		>
			{compact ? null : (
				<PaneHeader
					trailing={
						documentId && viewerReady ? (
							<TooltipProvider delayDuration={200}>
								<div className="flex items-center gap-0.5">
									{hasOverlaySource ? (
										<OverlayToggleButton
											visible={overlayVisible}
											onToggle={handleToggleOverlay}
										/>
									) : null}
									<Tooltip>
										<TooltipTrigger asChild>
											<QuietIconButton
												variant={running ? "secondary" : "ghost"}
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
											</QuietIconButton>
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
			)}

			{!documentId ? (
				<p className="px-3 py-8 text-center text-muted-foreground text-xs">
					{t("figures.noPaper")}
				</p>
			) : running && !hasRaw ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4">
					<div
						className="w-full max-w-[14rem] space-y-2"
						role="status"
						aria-live="polite"
					>
						<p className="text-center text-muted-foreground text-xs">
							{analysisMessage}
						</p>
						<Progress
							value={analysisProgress ?? undefined}
							aria-label={analysisMessage}
							className={cn(
								"h-1.5",
								analysisProgress == null && "animate-pulse opacity-70",
							)}
						/>
						{analysisProgressLabel ? (
							<p className="text-center text-caption text-muted-foreground tabular-nums">
								{analysisProgressLabel}
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
				<div className="flex min-h-0 flex-1 flex-col">
					{running ? (
						<div
							className="border-border/70 border-b bg-background/95 px-2 py-2"
							role="status"
							aria-live="polite"
						>
							<div className="mb-1 flex items-center justify-between gap-2 text-caption text-muted-foreground">
								<span className="min-w-0 truncate">{analysisMessage}</span>
								{analysisProgressLabel ? (
									<span className="shrink-0 tabular-nums">
										{analysisProgressLabel}
									</span>
								) : null}
							</div>
							<Progress
								value={analysisProgress ?? undefined}
								aria-label={analysisMessage}
								className={cn(
									"h-1",
									analysisProgress == null && "animate-pulse opacity-70",
								)}
							/>
						</div>
					) : null}
					<div className="agentero-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-2 [scrollbar-gutter:stable]">
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
						<Section
							title={t("figures.sectionFormulas")}
							count={formulas.length}
						>
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
				</div>
			)}
		</section>
	);
}
