/**
 * Compact import queue shown inside the magic-wand popover: one line per
 * active import job with a checkbox, drag-to-reorder for queued rows, and
 * select-all / cancel / move-to-front actions in the footer.
 *
 * The provider subscribes to the task store so only this subtree re-renders
 * on progress events; the surrounding sidebar header stays memoized.
 */

import { ArrowUpToLine, GripVertical, Loader2, X } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBackgroundTasks } from "@/hooks/use-background-tasks";
import {
	type BackgroundTask,
	cancelBackgroundTask,
	isActiveImportTask,
} from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { reorderImportQueue } from "@/lib/paper/import-queue";

type ImportQueueValue = {
	tasks: readonly BackgroundTask[];
	selected: ReadonlySet<string>;
	selectedCount: number;
	canPin: boolean;
	toggle: (id: string, checked: boolean) => void;
	toggleAll: () => void;
	cancelSelected: () => void;
	pinSelected: () => void;
	moveTask: (fromId: string, targetId: string, after: boolean) => void;
};

const ImportQueueContext = createContext<ImportQueueValue | null>(null);

function useImportQueue(): ImportQueueValue {
	const value = useContext(ImportQueueContext);
	if (!value) {
		throw new Error(
			"ImportQueueList / ImportQueueActions require ImportQueueProvider",
		);
	}
	return value;
}

/** Active import rows: running first, then queued in scheduler order. */
function activeImports(tasks: readonly BackgroundTask[]): BackgroundTask[] {
	return tasks.filter(isActiveImportTask).sort((a, b) => {
		const running =
			Number(b.status === "running") - Number(a.status === "running");
		return running || a.queueIndex - b.queueIndex || a.createdAt - b.createdAt;
	});
}

export function ImportQueueProvider({ children }: { children: ReactNode }) {
	const { tasks } = useBackgroundTasks();
	const active = useMemo(() => activeImports(tasks), [tasks]);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());

	// Finished / pruned rows must not keep an invisible selection alive.
	useEffect(() => {
		setSelected((prev) => {
			if (prev.size === 0) return prev;
			const activeIds = new Set(active.map((task) => task.id));
			let changed = false;
			const next = new Set<string>();
			for (const id of prev) {
				if (activeIds.has(id)) next.add(id);
				else changed = true;
			}
			return changed ? next : prev;
		});
	}, [active]);

	const queued = useMemo(
		() => active.filter((task) => task.status === "queued"),
		[active],
	);
	const selectedQueued = useMemo(
		() => queued.filter((task) => selected.has(task.id)),
		[queued, selected],
	);

	const toggle = (id: string, checked: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	};

	const toggleAll = () => {
		const allSelected =
			active.length > 0 && active.every((task) => selected.has(task.id));
		setSelected(allSelected ? new Set() : new Set(active.map((t) => t.id)));
	};

	const cancelSelected = () => {
		for (const id of selected) cancelBackgroundTask(id);
		setSelected(new Set());
	};

	const pinSelected = () => {
		if (selectedQueued.length === 0) return;
		const pinned = new Set(selectedQueued.map((task) => task.id));
		const ordered = [
			...selectedQueued.map((task) => task.id),
			...queued.filter((task) => !pinned.has(task.id)).map((task) => task.id),
		];
		void reorderImportQueue(ordered)
			.then(() => setSelected(new Set()))
			.catch((error) => notifyError(errorText(error)));
	};

	const moveTask = (fromId: string, targetId: string, after: boolean) => {
		if (fromId === targetId) return;
		const ids = queued.map((task) => task.id);
		if (!ids.includes(fromId)) return;
		const without = ids.filter((id) => id !== fromId);
		const targetIndex = without.indexOf(targetId);
		if (targetIndex < 0) return;
		without.splice(after ? targetIndex + 1 : targetIndex, 0, fromId);
		void reorderImportQueue(without).catch((error) =>
			notifyError(errorText(error)),
		);
	};

	return (
		<ImportQueueContext.Provider
			value={{
				tasks: active,
				selected,
				selectedCount: selected.size,
				canPin: selectedQueued.length > 0,
				toggle,
				toggleAll,
				cancelSelected,
				pinSelected,
				moveTask,
			}}
		>
			{children}
		</ImportQueueContext.Provider>
	);
}

/** Original identifier / batch head first, resolved title or phase after it. */
function taskLabel(task: BackgroundTask): string {
	const source = task.source?.trim();
	const detail = task.detail?.trim();
	if (source && detail && source !== detail) return `${source} · ${detail}`;
	return source || detail || task.title;
}

export function ImportQueueList() {
	const { t } = useTranslation(["sidebar", "app"]);
	const queue = useImportQueue();
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropSpot, setDropSpot] = useState<{
		id: string;
		after: boolean;
	} | null>(null);
	// A queued row can start (or disappear) mid-drag; drop the stale source so
	// the remaining rows do not keep advertising an invalid drop target.
	useEffect(() => {
		if (!dragId) return;
		const stillQueued = queue.tasks.some(
			(task) => task.id === dragId && task.status === "queued",
		);
		if (stillQueued) return;
		setDragId(null);
		setDropSpot(null);
	}, [dragId, queue.tasks]);
	if (queue.tasks.length === 0) return null;

	const allSelected =
		queue.tasks.length > 0 &&
		queue.tasks.every((task) => queue.selected.has(task.id));
	const someSelected = queue.selected.size > 0;

	return (
		<section className="flex flex-col">
			{/*
			 * Header and rows share the same scroll container so the select-all
			 * box sits exactly above the row checkboxes even when a classic
			 * scrollbar takes width. The header stays pinned while scrolling.
			 */}
			<div className="max-h-40 overflow-y-auto overscroll-contain pr-0.5">
				<div className="sticky top-0 z-10 flex items-center justify-between gap-1.5 bg-popover px-1 pb-1">
					<span className="text-caption text-muted-foreground">
						{t("app:tasks.activeCount", { count: queue.tasks.length })}
					</span>
					<Checkbox
						checked={
							allSelected ? true : someSelected ? "indeterminate" : false
						}
						onCheckedChange={queue.toggleAll}
						aria-label={t("lookup.queueSelectAll")}
					/>
				</div>
				<ul className="m-0 list-none p-0">
					{queue.tasks.map((task) => {
						const isQueued = task.status === "queued";
						const label = taskLabel(task);
						const dropped = dropSpot?.id === task.id && dragId !== task.id;
						return (
							<li
								key={task.id}
								draggable={isQueued}
								onDragStart={(event) => {
									if (!isQueued) return;
									event.dataTransfer.effectAllowed = "move";
									// Custom type only: dropping the row elsewhere must not
									// paste a job id into the lookup textarea.
									event.dataTransfer.setData(
										"application/x-agentero-import-task",
										task.id,
									);
									setDragId(task.id);
								}}
								onDragEnd={() => {
									setDragId(null);
									setDropSpot(null);
								}}
								onDragOver={(event) => {
									if (!dragId || !isQueued || dragId === task.id) return;
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									const rect = event.currentTarget.getBoundingClientRect();
									const after = event.clientY > rect.top + rect.height / 2;
									setDropSpot((prev) =>
										prev?.id === task.id && prev.after === after
											? prev
											: { id: task.id, after },
									);
								}}
								onDragLeave={(event) => {
									if (
										event.currentTarget.contains(
											event.relatedTarget as Node | null,
										)
									) {
										return;
									}
									setDropSpot((prev) => (prev?.id === task.id ? null : prev));
								}}
								onDrop={(event) => {
									event.preventDefault();
									if (dragId && isQueued && dragId !== task.id) {
										const rect = event.currentTarget.getBoundingClientRect();
										queue.moveTask(
											dragId,
											task.id,
											event.clientY > rect.top + rect.height / 2,
										);
									}
									setDragId(null);
									setDropSpot(null);
								}}
								className={cn(
									"flex h-7 select-none items-center gap-1.5 rounded border-y border-transparent px-1 text-xs",
									isQueued && "cursor-grab active:cursor-grabbing",
									dragId === task.id && "opacity-50",
									dropped &&
										(dropSpot?.after ? "border-b-primary" : "border-t-primary"),
								)}
							>
								{isQueued ? (
									<GripVertical
										className="size-3 shrink-0 text-muted-foreground/70"
										aria-hidden="true"
									/>
								) : (
									<Loader2 className="size-3 shrink-0 animate-spin text-primary" />
								)}
								<span className="min-w-0 flex-1 truncate" title={label}>
									{label}
								</span>
								{!isQueued && task.progress != null ? (
									<span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
										{Math.round(task.progress)}%
									</span>
								) : null}
								<Checkbox
									checked={queue.selected.has(task.id)}
									onCheckedChange={(value) =>
										queue.toggle(task.id, value === true)
									}
									aria-label={label}
								/>
							</li>
						);
					})}
				</ul>
			</div>
		</section>
	);
}

/** Footer actions; renders only while the queue has checked rows. */
export function ImportQueueActions() {
	const { t } = useTranslation("sidebar");
	const queue = useImportQueue();
	if (queue.selectedCount === 0) return null;
	return (
		<div className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="text-destructive"
						aria-label={t("lookup.queueRemove")}
						onClick={queue.cancelSelected}
					>
						<X className="size-3.5" />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="top">{t("lookup.queueRemove")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={t("lookup.queueMoveToFront")}
						disabled={!queue.canPin}
						onClick={queue.pinSelected}
					>
						<ArrowUpToLine className="size-3.5" />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="top">
					{t("lookup.queueMoveToFront")}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
