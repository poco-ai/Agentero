import { FileIcon, FolderIcon, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PaperTitle } from "@/components/paper/paper-title";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	listTrash,
	purgeTrashItem,
	restoreTrashItem,
	type TrashEntry,
} from "@/lib/paper/api";

/**
 * Recycle Bin center view (Zotero-style): lists items previously deleted into
 * `.agentero/.trash/` in the same full-pane area as the Library table, with
 * per-item Restore / Delete-permanently. Empty Recycle Bin lives on the
 * sidebar trash node context menu.
 */
export function RecycleBinView({
	vaultPath,
	active,
	onChanged,
	/** Incremented by parent after Empty Recycle Bin (sidebar menu). */
	reloadSignal = 0,
	className,
}: {
	vaultPath: string | null;
	/** True when this is the active tab (tabs stay mounted → reload on show). */
	active: boolean;
	/** Called after a restore so the parent can refresh tree / library / wiki. */
	onChanged: () => void | Promise<void>;
	reloadSignal?: number;
	className?: string;
}) {
	const { t, i18n } = useTranslation(["sidebar", "common"]);
	const [items, setItems] = useState<TrashEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
	/** Pending permanent-delete confirmation (Dialog instead of window.confirm). */
	const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);

	const reload = useCallback(async () => {
		if (!vaultPath) {
			setItems([]);
			return;
		}
		setLoading(true);
		try {
			setItems(await listTrash(vaultPath));
		} catch (e) {
			notifyError(e instanceof Error ? e.message : t("recycleBin.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, [vaultPath, t]);

	// Reload when shown, or after Empty Recycle Bin from the sidebar menu.
	useEffect(() => {
		void reloadSignal;
		if (active) void reload();
	}, [active, reload, reloadSignal]);

	const formatWhen = useCallback(
		(iso: string) => {
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return "";
			return new Intl.DateTimeFormat(i18n.language, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(d);
		},
		[i18n.language],
	);

	const handleRestore = useCallback(
		async (item: TrashEntry) => {
			if (!vaultPath || busyId) return;
			setBusyId(item.id);
			try {
				await restoreTrashItem(vaultPath, item.batchId, item.stored);
				setItems((prev) => prev.filter((x) => x.id !== item.id));
				await onChanged();
			} catch (e) {
				notifyError(e instanceof Error ? e.message : t("fileTree.undoFailed"));
			} finally {
				setBusyId(null);
			}
		},
		[vaultPath, busyId, onChanged, t],
	);

	const handlePurgeClick = useCallback(
		(item: TrashEntry) => {
			if (!vaultPath || busyId) return;
			setPurgeTarget(item);
		},
		[vaultPath, busyId],
	);

	const handlePurgeConfirm = useCallback(async () => {
		const item = purgeTarget;
		if (!vaultPath || !item || busyId) return;
		setPurgeTarget(null);
		setBusyId(item.id);
		try {
			await purgeTrashItem(vaultPath, item.batchId, item.stored);
			setItems((prev) => prev.filter((x) => x.id !== item.id));
		} catch (e) {
			notifyError(e instanceof Error ? e.message : t("recycleBin.purgeFailed"));
		} finally {
			setBusyId(null);
		}
	}, [vaultPath, purgeTarget, busyId, t]);

	return (
		<div
			className={cn(
				"flex min-h-0 min-w-0 flex-1 select-none flex-col",
				className,
			)}
		>
			{loading ? (
				<div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
					{t("recycleBin.loading")}
				</div>
			) : items.length === 0 ? (
				<div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-muted-foreground text-sm">
					{t("recycleBin.empty")}
				</div>
			) : (
				<div className="agentero-scroll min-h-0 min-w-0 flex-1">
					<TooltipProvider delayDuration={300}>
						<ul className="divide-y">
							{items.map((item) => {
								const Icon = item.isDir ? FolderIcon : FileIcon;
								return (
									<li
										key={item.id}
										className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40"
									>
										<Icon
											className={cn(
												"size-4 shrink-0",
												item.isDir ? "text-blue-500" : "text-muted-foreground",
											)}
										/>
										<div className="min-w-0 flex-1">
											{item.title ? (
												<PaperTitle
													text={item.title}
													className="block truncate text-sm"
												/>
											) : (
												<div className="truncate text-sm" title={item.name}>
													{item.name}
												</div>
											)}
											<div className="truncate text-caption text-muted-foreground">
												{item.rel} · {formatWhen(item.deletedAt)}
											</div>
										</div>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													className="size-7"
													aria-label={t("recycleBin.restore")}
													disabled={Boolean(busyId)}
													onClick={() => void handleRestore(item)}
												>
													<RotateCcw className="size-3.5" />
												</Button>
											</TooltipTrigger>
											<TooltipContent side="bottom">
												{t("recycleBin.restore")}
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													className="size-7 text-destructive"
													aria-label={t("recycleBin.deleteForever")}
													disabled={Boolean(busyId)}
													onClick={() => handlePurgeClick(item)}
												>
													<Trash2 className="size-3.5" />
												</Button>
											</TooltipTrigger>
											<TooltipContent side="bottom">
												{t("recycleBin.deleteForever")}
											</TooltipContent>
										</Tooltip>
									</li>
								);
							})}
						</ul>
					</TooltipProvider>
				</div>
			)}

			<Dialog
				open={purgeTarget !== null}
				onOpenChange={(open) => {
					if (!open) setPurgeTarget(null);
				}}
			>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("recycleBin.deleteForever")}</DialogTitle>
						<DialogDescription>
							{purgeTarget
								? t("recycleBin.deleteForeverConfirm", {
										name: purgeTarget.title ?? purgeTarget.name,
									})
								: null}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => setPurgeTarget(null)}
							disabled={Boolean(busyId)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => void handlePurgeConfirm()}
							disabled={Boolean(busyId)}
						>
							{t("recycleBin.deleteForever")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
