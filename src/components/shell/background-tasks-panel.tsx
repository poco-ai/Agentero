/**
 * Background tasks floater (bottom-left).
 * Collapsed: circular progress ring only.
 * Expanded / hover: task detail list (no summary toast chip).
 * Ring center cycles: progress % ↔ task icon.
 */
import {
	BookOpen,
	CheckCircle2,
	CircleX,
	Download,
	FileCode2,
	FileUp,
	LayoutGrid,
	ListOrdered,
	Loader2,
	Package,
	Plug,
	ScanSearch,
	Search,
	Settings,
	X,
} from "lucide-react";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBackgroundTasks } from "@/hooks/use-background-tasks";
import {
	type BackgroundTask,
	type BackgroundTaskIcon,
	type BackgroundTaskKind,
	cancelBackgroundTask,
	clearFinishedBackgroundTasks,
	getActiveBackgroundTasks,
	getBackgroundTasksSnapshot,
	isFinishedBackgroundTask,
	setBackgroundTasksExpanded,
} from "@/lib/core/background-tasks";
import { MOTION_MS, prefersReducedMotion } from "@/lib/core/motion";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";

/** Dwell before expanding detail from the ring (avoids flicker on pass-over). */
const HOVER_EXPAND_MS = 400;
/** Brief leave delay so a slip off the HUD does not slam it shut. */
const LEAVE_COLLAPSE_MS = 100;

/** Default icon per row kind; params-dependent rows carry an explicit hint. */
const KIND_ICONS: Partial<Record<BackgroundTaskKind, BackgroundTaskIcon>> = {
	downloadAssets: "download",
	modelDownload: "download",
	citingScan: "search",
	import: "fileUp",
	zoteroMigrate: "fileUp",
	libraryIo: "package",
	parseRefs: "layout",
	layoutAnalyze: "layout",
	layoutRun: "layout",
	connectorSync: "plug",
	recognizeMetadata: "scan",
	latexCompile: "fileCode",
	paperRead: "read",
	nodeInstall: "download",
};

function taskIcon(task: BackgroundTask | undefined): BackgroundTaskIcon {
	if (!task) return "list";
	return task.icon ?? KIND_ICONS[task.kind] ?? "list";
}

/**
 * Failed layout / reference-parse rows can be caused by a missing or invalid
 * provider key, so they offer a jump to the analysis settings (#656).
 */
const LAYOUT_SETTINGS_KINDS: ReadonlySet<BackgroundTaskKind> = new Set([
	"layoutAnalyze",
	"layoutRun",
	"parseRefs",
	"parseBody",
]);

/**
 * JobCenter-driven failures need their own top-right toast: unlike the
 * in-viewer run (`layoutRun`, which notifies from the viewer hook), headless
 * `layoutAnalyze` / `parseBody` / `parseRefs` jobs only project a panel row.
 * Excludes `layoutRun` to avoid a duplicate toast.
 */
const JOB_LAYOUT_TOAST_KINDS: ReadonlySet<BackgroundTaskKind> = new Set([
	"layoutAnalyze",
	"parseRefs",
	"parseBody",
]);

/** Center icon for the primary active task. */
function iconGlyph(icon: BackgroundTaskIcon) {
	const cls = "relative size-3.5 text-foreground";
	switch (icon) {
		case "download":
			return <Download className={cls} aria-hidden />;
		case "search":
			return <Search className={cls} aria-hidden />;
		case "fileUp":
			return <FileUp className={cls} aria-hidden />;
		case "package":
			return <Package className={cls} aria-hidden />;
		case "layout":
			return <LayoutGrid className={cls} aria-hidden />;
		case "read":
			return <BookOpen className={cls} aria-hidden />;
		case "plug":
			return <Plug className={cls} aria-hidden />;
		case "scan":
			return <ScanSearch className={cls} aria-hidden />;
		case "fileCode":
			return <FileCode2 className={cls} aria-hidden />;
		case "list":
			return <ListOrdered className={cls} aria-hidden />;
	}
}

function statusIcon(task: BackgroundTask) {
	switch (task.status) {
		case "running":
			return (
				<Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
			);
		case "queued":
			return (
				<ListOrdered className="size-3.5 shrink-0 text-muted-foreground" />
			);
		case "completed":
			return (
				<CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
			);
		case "failed":
			return <CircleX className="size-3.5 shrink-0 text-destructive" />;
		case "cancelled":
			return <CircleX className="size-3.5 shrink-0 text-muted-foreground" />;
	}
}

function TaskRow({ task }: { task: BackgroundTask }) {
	const { t } = useTranslation("app");
	const showBar =
		task.status === "running" ||
		task.status === "queued" ||
		task.progress !== null;

	// Keep trailing counters (e.g. "26 / 41 页") visible while truncating the
	// preceding label so progress never wraps to a second line.
	const [detailMain, detailTail] = useMemo(() => {
		if (!task.detail) return ["", null];
		const sep = " · ";
		const idx = task.detail.lastIndexOf(sep);
		if (idx <= 0) return [task.detail, null];
		return [task.detail.slice(0, idx), task.detail.slice(idx + sep.length)];
	}, [task.detail]);

	return (
		<div className="flex flex-col gap-1 border-b border-border/60 px-3 py-2.5 last:border-b-0">
			<div className="flex min-w-0 items-start gap-2">
				<span className="mt-0.5">{statusIcon(task)}</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-1.5">
						{task.queueIndex > 0 ? (
							<span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
								#{task.queueIndex}
							</span>
						) : null}
						<span className="truncate font-medium text-sm leading-tight">
							{task.title}
						</span>
						{task.progress != null &&
						(task.status === "running" || task.status === "queued") ? (
							<span className="ml-auto shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
								{Math.round(task.progress)}%
							</span>
						) : null}
					</div>
					{task.detail ? (
						<div
							className={cn(
								"mt-0.5 flex min-w-0 items-baseline gap-1 text-caption leading-snug text-muted-foreground",
								task.status === "failed" && "text-destructive",
							)}
							title={task.detail}
						>
							<span className="truncate">{detailMain}</span>
							{detailTail ? (
								<span className="shrink-0">{detailTail}</span>
							) : null}
						</div>
					) : null}
				</div>
				{task.status === "queued" || task.status === "running" ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-6 shrink-0"
								aria-label={t("tasks.cancel")}
								onClick={() => cancelBackgroundTask(task.id)}
							>
								<X className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="left">{t("tasks.cancel")}</TooltipContent>
					</Tooltip>
				) : null}
				{task.status === "failed" && LAYOUT_SETTINGS_KINDS.has(task.kind) ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-6 shrink-0"
								aria-label={t("tasks.openLayoutSettings")}
								onClick={() => openSettingsWindow("layout")}
							>
								<Settings className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="left">
							{t("tasks.openLayoutSettings")}
						</TooltipContent>
					</Tooltip>
				) : null}
			</div>
			{showBar &&
			task.status !== "completed" &&
			task.status !== "failed" &&
			task.status !== "cancelled" ? (
				<Progress
					value={task.progress ?? undefined}
					className={cn(
						"h-1",
						task.progress == null && "animate-pulse opacity-70",
					)}
				/>
			) : null}
		</div>
	);
}

type RingCenterPhase = "progress" | "icon";

const RING_CENTER_MS = 2400;
/** Success pop / ring-merge celebration after the last active task ends. */
const RING_SUCCESS_MS = 900;

/** Circular progress control — center cycles progress / task icon. */
function ProgressRing({
	activeCount,
	failed,
	label,
	progress,
	icon,
	onActivate,
}: {
	activeCount: number;
	failed: boolean;
	label: string;
	progress: number | null;
	icon: BackgroundTaskIcon;
	onActivate: () => void;
}) {
	const radius = 16;
	const circumference = 2 * Math.PI * radius;
	const finished = activeCount === 0;
	// Finished → always a closed (merged) ring at 100%. While running with no
	// numeric progress, keep the indeterminate arc.
	const isIndeterminate = !finished && progress == null;
	const normalizedProgress = finished
		? 100
		: progress == null
			? null
			: Math.max(0, Math.min(100, progress));
	const offset =
		normalizedProgress == null
			? 0
			: circumference - (normalizedProgress / 100) * circumference;

	const [phase, setPhase] = useState<RingCenterPhase>("progress");
	const [celebrate, setCelebrate] = useState(false);
	const prevActiveRef = useRef(activeCount);
	const active = activeCount > 0 && !failed;

	useEffect(() => {
		if (!active || prefersReducedMotion()) {
			setPhase("progress");
			return;
		}
		const order: RingCenterPhase[] = ["progress", "icon"];
		const id = window.setInterval(() => {
			setPhase((prev) => {
				const i = order.indexOf(prev);
				return order[(i + 1) % order.length] ?? "progress";
			});
		}, RING_CENTER_MS);
		return () => window.clearInterval(id);
	}, [active]);

	// Last active task ended successfully → play merge/success animation once.
	useEffect(() => {
		const prev = prevActiveRef.current;
		prevActiveRef.current = activeCount;
		if (prev > 0 && activeCount === 0 && !failed) {
			setCelebrate(true);
			const id = window.setTimeout(() => setCelebrate(false), RING_SUCCESS_MS);
			return () => window.clearTimeout(id);
		}
		if (activeCount > 0 || failed) {
			setCelebrate(false);
		}
	}, [activeCount, failed]);

	const center = (() => {
		if (failed) {
			return <CircleX className="relative size-3.5 text-destructive" />;
		}
		if (finished) {
			return (
				<CheckCircle2
					className={cn(
						"relative size-3.5 text-emerald-600 dark:text-emerald-400",
						celebrate && "task-ring-success-icon",
					)}
				/>
			);
		}
		// Active work: cycle progress ↔ task icon.
		if (phase === "icon") {
			return iconGlyph(icon);
		}
		// progress phase
		if (activeCount > 1) {
			return (
				<span className="relative font-mono font-medium text-caption tabular-nums">
					{activeCount}
				</span>
			);
		}
		if (normalizedProgress != null) {
			return (
				<span className="relative font-mono font-medium text-caption tabular-nums leading-none text-foreground">
					{Math.round(normalizedProgress)}%
				</span>
			);
		}
		// No numeric progress yet — show task icon.
		return iconGlyph(icon);
	})();

	return (
		<button
			type="button"
			className={cn(
				"relative flex size-9 items-center justify-center rounded-full bg-background text-foreground shadow-raised ring-1 ring-border transition-[opacity,transform] duration-100 hover:opacity-90 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
				celebrate && "task-ring-success-pulse",
			)}
			aria-label={label}
			aria-expanded={false}
			onClick={onActivate}
			onFocus={onActivate}
		>
			{/*
			 * Opaque disk (button bg) + SVG ring.
			 * Use ring-1 (box-shadow) not border so the content box stays size-9
			 * and the SVG (inset-0 size-full) shares the same center.
			 */}
			<svg
				className="pointer-events-none absolute inset-0 size-full -rotate-90"
				viewBox="0 0 40 40"
				aria-hidden="true"
				style={
					{
						"--task-ring-c": String(circumference),
					} as CSSProperties
				}
			>
				{/* Track: muted-foreground (not --muted, which is nearly white in light mode). */}
				<circle
					cx="20"
					cy="20"
					r={radius}
					fill="none"
					stroke="currentColor"
					strokeWidth="3"
					className="text-muted-foreground/30"
				/>
				<circle
					cx="20"
					cy="20"
					r={radius}
					fill="none"
					stroke="currentColor"
					strokeLinecap="round"
					strokeWidth="3"
					strokeDasharray={
						isIndeterminate
							? `${circumference * 0.28} ${circumference}`
							: circumference
					}
					strokeDashoffset={offset}
					className={cn(
						"text-primary transition-[stroke-dashoffset,stroke] duration-500 ease-out",
						isIndeterminate && "task-ring-indeterminate",
						failed && "text-destructive",
						finished && !failed && "text-emerald-600 dark:text-emerald-400",
						celebrate && "task-ring-success-stroke",
					)}
				/>
			</svg>
			{/* Center content — flex-centered on the same size-9 box as the SVG */}
			<span className="pointer-events-none relative z-10 flex items-center justify-center">
				{center}
			</span>
		</button>
	);
}

/** Auto-collapse error detail if the pointer never enters the panel. */
const ERROR_DETAIL_MS = 5000;

export function BackgroundTasksPanel({ className }: { className?: string }) {
	const { t } = useTranslation("app");
	const { tasks } = useBackgroundTasks();
	/**
	 * Detail open is hover-driven; store.expanded is only a fail signal.
	 * `detailMounted` keeps the panel in the DOM through the exit transition;
	 * `detailVisible` drives opacity/scale so enter and exit share one path.
	 */
	const [detailMounted, setDetailMounted] = useState(false);
	const [detailVisible, setDetailVisible] = useState(false);
	const pointerInsideRef = useRef(false);
	const hoverExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const leaveCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const exitAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const errorCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const seenFailedIdsRef = useRef<Set<string>>(new Set());
	const detailOpen = detailMounted && detailVisible;

	const clearHoverTimers = useCallback(() => {
		if (hoverExpandTimerRef.current) {
			clearTimeout(hoverExpandTimerRef.current);
			hoverExpandTimerRef.current = null;
		}
		if (leaveCollapseTimerRef.current) {
			clearTimeout(leaveCollapseTimerRef.current);
			leaveCollapseTimerRef.current = null;
		}
	}, []);

	const openDetail = useCallback(() => {
		clearHoverTimers();
		if (exitAnimTimerRef.current) {
			clearTimeout(exitAnimTimerRef.current);
			exitAnimTimerRef.current = null;
		}
		if (errorCollapseTimerRef.current) {
			clearTimeout(errorCollapseTimerRef.current);
			errorCollapseTimerRef.current = null;
		}
		setBackgroundTasksExpanded(true);
		setDetailMounted(true);
		// Double rAF so the enter transition starts from the collapsed frame.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => setDetailVisible(true));
		});
	}, [clearHoverTimers]);

	const closeDetail = useCallback(() => {
		clearHoverTimers();
		if (errorCollapseTimerRef.current) {
			clearTimeout(errorCollapseTimerRef.current);
			errorCollapseTimerRef.current = null;
		}
		setDetailVisible(false);
		setBackgroundTasksExpanded(false);
		if (exitAnimTimerRef.current) {
			clearTimeout(exitAnimTimerRef.current);
		}
		const exitMs = prefersReducedMotion() ? 0 : MOTION_MS.normal;
		exitAnimTimerRef.current = setTimeout(() => {
			exitAnimTimerRef.current = null;
			setDetailMounted(false);
		}, exitMs);
	}, [clearHoverTimers]);

	const scheduleHoverExpand = useCallback(() => {
		pointerInsideRef.current = true;
		if (leaveCollapseTimerRef.current) {
			clearTimeout(leaveCollapseTimerRef.current);
			leaveCollapseTimerRef.current = null;
		}
		if (errorCollapseTimerRef.current) {
			clearTimeout(errorCollapseTimerRef.current);
			errorCollapseTimerRef.current = null;
		}
		if (detailMounted) {
			// Re-entering mid-exit: cancel unmount and show again.
			if (exitAnimTimerRef.current) {
				clearTimeout(exitAnimTimerRef.current);
				exitAnimTimerRef.current = null;
			}
			setDetailVisible(true);
			setBackgroundTasksExpanded(true);
			return;
		}
		if (hoverExpandTimerRef.current) {
			clearTimeout(hoverExpandTimerRef.current);
			hoverExpandTimerRef.current = null;
		}
		hoverExpandTimerRef.current = setTimeout(() => {
			hoverExpandTimerRef.current = null;
			if (pointerInsideRef.current) openDetail();
		}, HOVER_EXPAND_MS);
	}, [detailMounted, openDetail]);

	const collapseOnLeave = useCallback(() => {
		pointerInsideRef.current = false;
		if (hoverExpandTimerRef.current) {
			clearTimeout(hoverExpandTimerRef.current);
			hoverExpandTimerRef.current = null;
		}
		if (leaveCollapseTimerRef.current) {
			clearTimeout(leaveCollapseTimerRef.current);
		}
		leaveCollapseTimerRef.current = setTimeout(() => {
			leaveCollapseTimerRef.current = null;
			if (!pointerInsideRef.current) closeDetail();
		}, LEAVE_COLLAPSE_MS);
	}, [closeDetail]);

	const active = useMemo(() => getActiveBackgroundTasks(tasks), [tasks]);
	const visible = useMemo(() => {
		const act = [...active].sort((a, b) => a.queueIndex - b.queueIndex);
		const done = tasks
			.filter(isFinishedBackgroundTask)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 6);
		return [...act, ...done];
	}, [tasks, active]);

	const hasFinished = tasks.some(isFinishedBackgroundTask);
	const hasFailed = visible.some((task) => task.status === "failed");
	const failedIdsKey = useMemo(
		() =>
			tasks
				.filter((task) => task.status === "failed")
				.map((task) => task.id)
				.sort()
				.join("|"),
		[tasks],
	);

	// New failures: open detail briefly so the user can see the error; if they
	// never hover, collapse back to the ring automatically.
	useEffect(() => {
		if (!failedIdsKey) {
			seenFailedIdsRef.current = new Set();
			return;
		}
		const ids = failedIdsKey.split("|").filter(Boolean);
		const fresh = ids.filter((id) => !seenFailedIdsRef.current.has(id));
		for (const id of ids) seenFailedIdsRef.current.add(id);
		if (fresh.length === 0) return;

		// Headless layout / parse jobs have no viewer toast of their own — surface
		// a top-right error with a jump to the analysis settings.
		const failedTasks = getBackgroundTasksSnapshot().tasks;
		for (const id of fresh) {
			const task = failedTasks.find((item) => item.id === id);
			if (!task || !JOB_LAYOUT_TOAST_KINDS.has(task.kind)) continue;
			notifyError(task.title, {
				description: task.error?.trim() || undefined,
				id: `layout-failed-${id}`,
				action: {
					label: t("tasks.openLayoutSettings"),
					onClick: () => openSettingsWindow("layout"),
				},
			});
		}

		openDetail();
		if (errorCollapseTimerRef.current) {
			clearTimeout(errorCollapseTimerRef.current);
		}
		errorCollapseTimerRef.current = setTimeout(() => {
			errorCollapseTimerRef.current = null;
			if (!pointerInsideRef.current) closeDetail();
		}, ERROR_DETAIL_MS);
	}, [failedIdsKey, openDetail, closeDetail, t]);

	useEffect(() => {
		return () => {
			if (hoverExpandTimerRef.current) {
				clearTimeout(hoverExpandTimerRef.current);
				hoverExpandTimerRef.current = null;
			}
			if (leaveCollapseTimerRef.current) {
				clearTimeout(leaveCollapseTimerRef.current);
				leaveCollapseTimerRef.current = null;
			}
			if (exitAnimTimerRef.current) {
				clearTimeout(exitAnimTimerRef.current);
				exitAnimTimerRef.current = null;
			}
			if (errorCollapseTimerRef.current) {
				clearTimeout(errorCollapseTimerRef.current);
				errorCollapseTimerRef.current = null;
			}
		};
	}, []);

	// No tasks left → force ring state for the next job.
	useEffect(() => {
		if (tasks.length === 0 && detailMounted) closeDetail();
	}, [tasks.length, detailMounted, closeDetail]);

	if (tasks.length === 0) return null;

	const ringProgress =
		active.length > 0 && active.some((task) => task.progress != null)
			? Math.round(
					active
						.filter((task) => task.progress != null)
						.reduce((sum, task) => sum + (task.progress ?? 0), 0) /
						active.filter((task) => task.progress != null).length,
				)
			: null;

	const ringLabel =
		active.length === 0
			? t("tasks.idle")
			: active.length === 1
				? (active[0]?.title ?? t("tasks.title"))
				: t("tasks.activeCount", { count: active.length });

	const reduceMotion = prefersReducedMotion();

	return (
		<TooltipProvider delayDuration={300}>
			<section
				className={cn(
					"pointer-events-auto fixed bottom-3 left-3 z-50 flex flex-col items-start origin-bottom-left",
					"transition-[width] ease-out",
					reduceMotion ? "duration-0" : "duration-200",
					detailOpen ? "w-[min(20rem,calc(100vw-1.5rem))]" : "w-9",
					className,
				)}
				aria-label={t("tasks.title")}
				onMouseEnter={scheduleHoverExpand}
				onMouseLeave={collapseOnLeave}
			>
				{detailMounted ? (
					<div
						className={cn(
							"w-full origin-bottom-left overflow-hidden rounded-lg border border-border/70 bg-popover text-popover-foreground shadow-overlay",
							"transition-[opacity,transform] ease-out",
							reduceMotion ? "duration-150" : "duration-200",
							detailVisible
								? "scale-100 opacity-100"
								: reduceMotion
									? "opacity-0"
									: "scale-95 opacity-0",
						)}
					>
						<div className="flex h-9 items-center gap-1 border-b border-border/60 bg-muted/30 px-2.5">
							<span className="min-w-0 flex-1 truncate px-1 font-medium text-sm">
								{t("tasks.title")}
								{active.length > 0 ? (
									<span className="ml-1.5 text-muted-foreground tabular-nums">
										({active.length})
									</span>
								) : null}
							</span>
							{hasFinished ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											className="size-6"
											aria-label={t("tasks.clearFinished")}
											onClick={() => clearFinishedBackgroundTasks()}
										>
											<X className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="top">
										{t("tasks.clearFinished")}
									</TooltipContent>
								</Tooltip>
							) : null}
						</div>
						<div className="agentero-scroll max-h-56 overflow-y-auto">
							{visible.length === 0 ? (
								<p className="px-3 py-4 text-center text-muted-foreground text-xs">
									{t("tasks.empty")}
								</p>
							) : (
								visible.map((task) => <TaskRow key={task.id} task={task} />)
							)}
						</div>
					</div>
				) : (
					<ProgressRing
						activeCount={active.length}
						failed={hasFailed}
						label={ringLabel}
						progress={ringProgress}
						icon={taskIcon(active[0])}
						onActivate={() => {
							pointerInsideRef.current = true;
							clearHoverTimers();
							openDetail();
						}}
					/>
				)}
			</section>
		</TooltipProvider>
	);
}
