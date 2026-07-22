/**
 * IDE-style background tasks floater (bottom-left).
 * Collapsed chip when work is running; click expands queue + progress.
 * Hidden when there are no tasks.
 */
import {
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	CircleX,
	ListOrdered,
	Loader2,
	X,
} from "lucide-react";
import { useMemo } from "react";
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
import { cn } from "@/lib/utils";
import {
	type BackgroundTask,
	clearFinishedBackgroundTasks,
	getActiveBackgroundTasks,
	setBackgroundTasksExpanded,
} from "@/stores/background-tasks-store";

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
	}
}

function TaskRow({ task }: { task: BackgroundTask }) {
	const showBar =
		task.status === "running" ||
		task.status === "queued" ||
		task.progress !== null;

	return (
		<div className="flex flex-col gap-1 border-b border-border/60 px-2.5 py-2 last:border-b-0">
			<div className="flex min-w-0 items-start gap-2">
				<span className="mt-0.5">{statusIcon(task)}</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-1.5">
						{task.queueIndex > 0 ? (
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
								#{task.queueIndex}
							</span>
						) : null}
						<span className="truncate font-medium text-xs leading-tight">
							{task.title}
						</span>
						{task.progress != null &&
						(task.status === "running" || task.status === "queued") ? (
							<span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
								{Math.round(task.progress)}%
							</span>
						) : null}
					</div>
					{task.detail ? (
						<p
							className={cn(
								"mt-0.5 truncate text-[11px] leading-snug text-muted-foreground",
								task.status === "failed" && "text-destructive",
							)}
							title={task.detail}
						>
							{task.detail}
						</p>
					) : null}
				</div>
			</div>
			{showBar && task.status !== "completed" && task.status !== "failed" ? (
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

export function BackgroundTasksPanel({ className }: { className?: string }) {
	const { t } = useTranslation("app");
	const { tasks, expanded } = useBackgroundTasks();

	const active = useMemo(() => getActiveBackgroundTasks(tasks), [tasks]);
	const visible = useMemo(() => {
		// Active first (by queue), then recent finished (newest last → reverse for display)
		const act = tasks
			.filter((x) => x.status === "queued" || x.status === "running")
			.sort((a, b) => a.queueIndex - b.queueIndex);
		const done = tasks
			.filter((x) => x.status === "completed" || x.status === "failed")
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 6);
		return [...act, ...done];
	}, [tasks]);

	const running = active.find((t) => t.status === "running") ?? active[0];
	const hasFinished = tasks.some(
		(t) => t.status === "completed" || t.status === "failed",
	);

	if (tasks.length === 0) return null;

	const chipLabel =
		active.length === 0
			? t("tasks.idle")
			: active.length === 1 && running
				? running.title
				: t("tasks.activeCount", { count: active.length });

	const chipProgress =
		running?.progress != null && running.status === "running"
			? running.progress
			: null;

	return (
		<TooltipProvider delayDuration={300}>
			<div
				className={cn(
					"pointer-events-auto fixed bottom-3 left-3 z-50 flex w-[min(20rem,calc(100vw-1.5rem))] flex-col items-stretch gap-1",
					className,
				)}
			>
				{/* Expanded list — IDE style popover above the chip */}
				{expanded ? (
					<div className="overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
						<div className="flex h-8 items-center gap-1 border-b bg-muted/40 px-2">
							<span className="min-w-0 flex-1 truncate px-1 font-medium text-xs">
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
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										className="size-6"
										aria-label={t("tasks.collapse")}
										onClick={() => setBackgroundTasksExpanded(false)}
									>
										<ChevronDown className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">
									{t("tasks.collapse")}
								</TooltipContent>
							</Tooltip>
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
				) : null}

				{/* Collapsed status chip — always when tasks exist */}
				<button
					type="button"
					className={cn(
						"flex w-full items-center gap-2 rounded-md border bg-popover px-2.5 py-1.5 text-left shadow-md",
						// Solid hover — avoid /opacity so content under the floater does not show through
						"hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					)}
					aria-expanded={expanded}
					aria-label={t("tasks.toggle")}
					onClick={() => setBackgroundTasksExpanded(!expanded)}
				>
					{active.length > 0 ? (
						<Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
					) : (
						<CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
					)}
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium text-xs leading-tight">
							{chipLabel}
						</p>
						{running?.detail && active.length > 0 ? (
							<p className="truncate text-[10px] text-muted-foreground leading-tight">
								{running.detail}
							</p>
						) : null}
						{chipProgress != null ? (
							<Progress value={chipProgress} className="mt-1 h-0.5" />
						) : active.length > 0 ? (
							<div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-muted">
								<div className="h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
							</div>
						) : null}
					</div>
					{expanded ? (
						<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
					) : (
						<ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
					)}
				</button>
			</div>
		</TooltipProvider>
	);
}
