/**
 * Native 广场 panel: user RSS / Atom subscriptions and a paper-aware timeline.
 *
 * @see docs/development/plaza-feeds.md
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import type { TFunction } from "i18next";
import { EllipsisVertical, EyeOff, Pin, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PlazaFeedItemDetail,
	PlazaFeedItemRow,
} from "@/components/plaza/plaza-feeds-item";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	ARXIV_FEED_CHIPS,
	arxivFeedUrl,
	compareFeedSubs,
	type FeedItem,
	type FeedSub,
	feedsAdd,
	feedsItems,
	feedsList,
	feedsMarkImported,
	feedsRefresh,
	feedsRemove,
	feedsRename,
	feedsSetPinned,
	feedsSetRead,
	hostErrorKey,
	importFeedItem,
} from "@/lib/plaza/feeds";

const STALE_REFRESH_MS = 15 * 60 * 1000;

function toastHostError(message: string, t: TFunction<"sidebar">): void {
	const key = hostErrorKey(message);
	notifyError(key ? t(key) : message);
}

function formatHostError(message: string, t: TFunction<"sidebar">): string {
	const key = hostErrorKey(message);
	return key ? t(key) : message;
}

type FeedSubMenuState = { sub: FeedSub; x: number; y: number };

const MENU_ITEM_CLASS =
	"flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground";

function openFeedSubMenu(
	sub: FeedSub,
	event: {
		preventDefault(): void;
		stopPropagation(): void;
		clientX: number;
		clientY: number;
	},
	setMenu: (next: FeedSubMenuState) => void,
): void {
	event.preventDefault();
	event.stopPropagation();
	setMenu({ sub, x: event.clientX, y: event.clientY });
}

function FeedSubMenu({
	menu,
	onClose,
	onRename,
	onCopyUrl,
	onRefresh,
	onPin,
	onRemove,
}: {
	menu: FeedSubMenuState;
	onClose: () => void;
	onRename: (sub: FeedSub) => void;
	onCopyUrl: (sub: FeedSub) => void;
	onRefresh: (sub: FeedSub) => void;
	onPin: (sub: FeedSub) => void;
	onRemove: (sub: FeedSub) => void;
}) {
	const { t } = useTranslation("sidebar");
	const menuRef = useRef<HTMLDivElement>(null);

	// Re-bind when the menu opens at a new point so the opening click
	// does not immediately dismiss it (same pattern as the file tree).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onPointer = (event: PointerEvent) => {
			const el = menuRef.current;
			if (el && event.target instanceof Node && el.contains(event.target)) {
				return;
			}
			onClose();
		};
		const timer = window.setTimeout(() => {
			window.addEventListener("pointerdown", onPointer, true);
			window.addEventListener("keydown", onKey, true);
			window.addEventListener("scroll", onClose, true);
			window.addEventListener("resize", onClose);
		}, 0);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("pointerdown", onPointer, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", onClose, true);
			window.removeEventListener("resize", onClose);
		};
	}, [menu, onClose]);

	const run = (action: (sub: FeedSub) => void) => {
		action(menu.sub);
		onClose();
	};

	return (
		<ViewportFloating
			floatingRef={menuRef}
			point={{ x: menu.x, y: menu.y }}
			role="menu"
			className="z-[2000] min-w-44 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-overlay ring-1 ring-foreground/10"
		>
			<button
				type="button"
				role="menuitem"
				className={MENU_ITEM_CLASS}
				onClick={() => run(onRename)}
			>
				{t("plaza.feeds.rename")}
			</button>
			<button
				type="button"
				role="menuitem"
				className={MENU_ITEM_CLASS}
				onClick={() => run(onCopyUrl)}
			>
				{t("plaza.feeds.copyUrl")}
			</button>
			<button
				type="button"
				role="menuitem"
				className={MENU_ITEM_CLASS}
				onClick={() => run(onRefresh)}
			>
				{t("plaza.feeds.refreshOne")}
			</button>
			<button
				type="button"
				role="menuitem"
				className={MENU_ITEM_CLASS}
				onClick={() => run(onPin)}
			>
				{menu.sub.pinned ? t("plaza.feeds.unpin") : t("plaza.feeds.pin")}
			</button>
			<div className="-mx-1 my-1 h-px bg-border" />
			<button
				type="button"
				role="menuitem"
				className={cn(
					MENU_ITEM_CLASS,
					"text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive",
				)}
				onClick={() => run(onRemove)}
			>
				{t("plaza.feeds.remove")}
			</button>
		</ViewportFloating>
	);
}

function AddForm({
	busy,
	refreshing,
	onAdd,
	onRefresh,
	showRefresh,
	showChips,
}: {
	busy: boolean;
	refreshing: boolean;
	onAdd: (url: string) => void;
	onRefresh: () => void;
	showRefresh: boolean;
	showChips: boolean;
}) {
	const { t } = useTranslation("sidebar");
	const [url, setUrl] = useState("");
	return (
		<form
			className="space-y-2"
			onSubmit={(event) => {
				event.preventDefault();
				const next = url.trim();
				if (!next || busy) return;
				onAdd(next);
				setUrl("");
			}}
		>
			<div className="flex items-center gap-1.5">
				<Input
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					placeholder={t("plaza.feeds.urlPlaceholder")}
					disabled={busy}
					aria-label={t("plaza.feeds.urlPlaceholder")}
					className="h-8 min-w-0 flex-1"
				/>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="submit"
							size="icon-sm"
							disabled={busy || !url.trim()}
							aria-label={t("plaza.feeds.add")}
						>
							<Plus className="size-3.5" aria-hidden />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.feeds.add")}</TooltipContent>
				</Tooltip>
				{showRefresh ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={refreshing}
								aria-label={t("plaza.feeds.refresh")}
								onClick={onRefresh}
							>
								<RefreshCw
									className={cn("size-3.5", refreshing && "animate-spin")}
									aria-hidden
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("plaza.feeds.refresh")}</TooltipContent>
					</Tooltip>
				) : null}
			</div>
			{showChips ? (
				<div className="flex flex-wrap gap-1">
					{ARXIV_FEED_CHIPS.map((cat) => (
						<Button
							key={cat}
							type="button"
							variant="outline"
							size="xs"
							disabled={busy}
							onClick={() => onAdd(arxivFeedUrl(cat))}
						>
							{cat}
						</Button>
					))}
				</div>
			) : null}
		</form>
	);
}

export function PlazaFeedsView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [subs, setSubs] = useState<FeedSub[]>([]);
	const [hideRead, setHideRead] = useState(false);
	const hideReadRef = useRef(hideRead);
	hideReadRef.current = hideRead;
	const itemsRequest = useRef(0);
	const importPending = useRef(new Set<string>());
	const [importingIds, setImportingIds] = useState<Set<string>>(
		() => new Set(),
	);
	const readPending = useRef(new Set<string>());
	const [items, setItems] = useState<FeedItem[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [renameTarget, setRenameTarget] = useState<FeedSub | null>(null);
	const [renameTitle, setRenameTitle] = useState("");
	const [openItem, setOpenItem] = useState<FeedItem | null>(null);
	const [subMenu, setSubMenu] = useState<FeedSubMenuState | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const closeSubMenu = useCallback(() => setSubMenu(null), []);

	const loadItems = useCallback(
		async (subscriptionId: string | null, closeDetail = true) => {
			const request = ++itemsRequest.current;
			if (closeDetail) setOpenItem(null);
			try {
				const rows = await feedsItems({
					subscriptionId: subscriptionId ?? undefined,
					filter: hideReadRef.current ? "unread" : "all",
				});
				if (request === itemsRequest.current) setItems(rows);
			} catch (error) {
				toastHostError(errorText(error), t);
			}
		},
		[t],
	);

	const selectedIdRef = useRef(selectedId);
	selectedIdRef.current = selectedId;

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			setLoading(true);
			try {
				const next = await feedsList();
				if (cancelled) return;
				setSubs([...next].sort(compareFeedSubs));
				await loadItems(selectedIdRef.current, false);
			} catch (error) {
				if (!cancelled) {
					toastHostError(errorText(error), t);
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [loadItems, t]);

	useEffect(() => {
		let cancelled = false;
		const runStale = async () => {
			try {
				const result = await feedsRefresh({ staleOnly: true });
				if (cancelled) return;
				setSubs([...result.subscriptions].sort(compareFeedSubs));
				await loadItems(selectedIdRef.current, false);
			} catch {
				/* stale refresh is best-effort */
			}
		};
		void runStale();
		const timer = window.setInterval(() => void runStale(), STALE_REFRESH_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [loadItems]);

	const onAdd = useCallback(
		async (url: string) => {
			setBusy(true);
			try {
				const sub = await feedsAdd(url);
				setSubs((prev) =>
					prev.some((row) => row.id === sub.id)
						? prev
						: [...prev, sub].sort(compareFeedSubs),
				);
				setSelectedId(sub.id);
				await loadItems(sub.id);
			} catch (error) {
				toastHostError(errorText(error), t);
			} finally {
				setBusy(false);
			}
		},
		[loadItems, t],
	);

	const onRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			const result = await feedsRefresh({
				id: selectedId ?? undefined,
			});
			setSubs([...result.subscriptions].sort(compareFeedSubs));
			await loadItems(selectedId);
		} catch (error) {
			toastHostError(errorText(error), t);
		} finally {
			setRefreshing(false);
		}
	}, [loadItems, selectedId, t]);

	const onRemove = useCallback(
		async (id: string) => {
			try {
				await feedsRemove(id);
				setSubs((prev) => prev.filter((row) => row.id !== id));
				if (selectedId === id) {
					setSelectedId(null);
					await loadItems(null);
				} else {
					await loadItems(selectedId);
				}
			} catch (error) {
				toastHostError(errorText(error), t);
			}
		},
		[loadItems, selectedId, t],
	);

	const applySub = useCallback((next: FeedSub) => {
		setSubs((prev) =>
			prev
				.map((row) => (row.id === next.id ? next : row))
				.sort(compareFeedSubs),
		);
	}, []);

	const applyItem = useCallback((next: FeedItem) => {
		setItems((prev) =>
			prev.map((row) =>
				row.id === next.id ? { ...next, readAt: row.readAt } : row,
			),
		);
		setOpenItem((current) =>
			current?.id === next.id ? { ...next, readAt: current.readAt } : current,
		);
	}, []);

	const importItem = useCallback(
		async (item: FeedItem) => {
			if (item.importedAt || importPending.current.has(item.id)) return;
			importPending.current.add(item.id);
			setImportingIds(new Set(importPending.current));
			try {
				if (await importFeedItem(item)) {
					applyItem(await feedsMarkImported(item.id));
				}
			} catch (error) {
				toastHostError(errorText(error), t);
			} finally {
				importPending.current.delete(item.id);
				setImportingIds(new Set(importPending.current));
			}
		},
		[applyItem, t],
	);

	const setRead = useCallback(
		async (item: FeedItem, read: boolean) => {
			if (readPending.current.has(item.id)) return;
			readPending.current.add(item.id);
			try {
				const next = await feedsSetRead(item.id, read);
				setItems((rows) =>
					rows.map((row) =>
						row.id === item.id ? { ...row, readAt: next.readAt } : row,
					),
				);
				setOpenItem((current) =>
					current?.id === item.id
						? { ...current, readAt: next.readAt }
						: current,
				);
			} catch (error) {
				toastHostError(errorText(error), t);
			} finally {
				readPending.current.delete(item.id);
			}
		},
		[t],
	);

	const openFeedItem = useCallback(
		(item: FeedItem) => {
			setOpenItem(item);
			if (!item.readAt) void setRead(item, true);
		},
		[setRead],
	);

	const onPin = useCallback(
		async (id: string, pinned: boolean) => {
			try {
				applySub(await feedsSetPinned(id, pinned));
			} catch (error) {
				toastHostError(errorText(error), t);
			}
		},
		[applySub, t],
	);

	const onRename = useCallback(async () => {
		if (!renameTarget) return;
		const title = renameTitle.trim();
		if (!title) return;
		try {
			const next = await feedsRename(renameTarget.id, title);
			applySub(next);
			setItems((prev) =>
				prev.map((row) =>
					row.subscriptionId === next.id
						? { ...row, subscriptionTitle: next.title }
						: row,
				),
			);
			setRenameTarget(null);
		} catch (error) {
			toastHostError(errorText(error), t);
		}
	}, [applySub, renameTarget, renameTitle, t]);

	const visibleItems = useMemo(
		() => (hideRead ? items.filter((item) => !item.readAt) : items),
		[hideRead, items],
	);
	const virtualizer = useVirtualizer({
		count: visibleItems.length,
		getScrollElement: () => listRef.current,
		estimateSize: () => 92,
		overscan: 8,
	});

	const selected = selectedId
		? (subs.find((row) => row.id === selectedId) ?? null)
		: null;
	const emptyItems = !loading && visibleItems.length === 0;
	const hasSubs = subs.length > 0;

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			{hasSubs ? (
				<div className="shrink-0 border-b px-4 py-3">
					<AddForm
						busy={busy}
						refreshing={refreshing}
						onAdd={(url) => void onAdd(url)}
						onRefresh={() => void onRefresh()}
						showRefresh
						showChips={false}
					/>
				</div>
			) : null}

			{!hasSubs ? (
				<div className="flex flex-1 flex-col items-center justify-center p-6">
					<div className="w-full max-w-md space-y-3">
						<p className="text-center font-medium text-sm">
							{t("plaza.feeds.emptyTitle")}
						</p>
						<AddForm
							busy={busy}
							refreshing={false}
							onAdd={(url) => void onAdd(url)}
							onRefresh={() => undefined}
							showRefresh={false}
							showChips
						/>
						<p className="text-center text-muted-foreground text-xs leading-relaxed">
							{t("plaza.feeds.emptyHint")}
						</p>
					</div>
				</div>
			) : (
				<div className="flex min-h-0 min-w-0 flex-1">
					<nav className="flex w-52 shrink-0 select-none flex-col border-r">
						<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-2">
							<button
								type="button"
								onClick={() => {
									setSelectedId(null);
									void loadItems(null);
								}}
								className={cn(
									"flex w-full rounded-md px-2 py-1.5 text-left text-sm",
									"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
									selectedId === null
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
								)}
							>
								{t("plaza.feeds.all")}
							</button>
							{subs.map((sub) => (
								<div key={sub.id} className="group/feed relative mt-0.5">
									<button
										type="button"
										onClick={() => {
											setSelectedId(sub.id);
											void loadItems(sub.id);
										}}
										onContextMenu={(event) =>
											openFeedSubMenu(sub, event, setSubMenu)
										}
										className={cn(
											"flex w-full flex-col rounded-md py-1.5 pr-7 pl-2 text-left",
											"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
											selectedId === sub.id
												? "bg-muted text-foreground"
												: "hover:bg-muted/60",
										)}
									>
										<span className="flex min-w-0 items-center gap-1">
											{sub.pinned ? (
												<Pin
													className="size-3 shrink-0 text-muted-foreground"
													aria-hidden
												/>
											) : null}
											<span className="truncate text-sm">{sub.title}</span>
										</span>
										{sub.lastError ? (
											<span className="truncate text-destructive text-xs">
												{formatHostError(sub.lastError, t)}
											</span>
										) : null}
									</button>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="absolute top-1 right-0.5 size-6 opacity-0 group-hover/feed:opacity-100 focus-visible:opacity-100"
												aria-label={t("plaza.feeds.more")}
												onClick={(event) => {
													event.stopPropagation();
													const rect =
														event.currentTarget.getBoundingClientRect();
													setSubMenu({
														sub,
														x: rect.right,
														y: rect.bottom,
													});
												}}
											>
												<EllipsisVertical className="size-3.5" aria-hidden />
											</Button>
										</TooltipTrigger>
										<TooltipContent>{t("plaza.feeds.more")}</TooltipContent>
									</Tooltip>
								</div>
							))}
						</div>
					</nav>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						<div className="flex shrink-0 justify-end border-b px-2 py-1">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-pressed={hideRead}
										className={cn(
											hideRead && "bg-accent text-accent-foreground",
										)}
										aria-label={t("plaza.feeds.hideRead")}
										onClick={() => {
											hideReadRef.current = !hideRead;
											setHideRead(!hideRead);
											void loadItems(selectedId, false);
										}}
									>
										<EyeOff className="size-3.5" aria-hidden />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("plaza.feeds.hideRead")}</TooltipContent>
							</Tooltip>
						</div>
						{openItem ? (
							<PlazaFeedItemDetail
								item={openItem}
								hideSource={selectedId !== null}
								onBack={() => {
									setOpenItem(null);
									if (hideRead) void loadItems(selectedId);
								}}
								onToggleRead={() => void setRead(openItem, !openItem.readAt)}
								onImport={(item) => void importItem(item)}
								importing={importingIds.has(openItem.id)}
								onResolved={applyItem}
							/>
						) : emptyItems ? (
							<div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
								{selected?.lastError
									? formatHostError(selected.lastError, t)
									: t(
											hideRead
												? "plaza.feeds.emptyUnread"
												: "plaza.feeds.emptyItems",
										)}
							</div>
						) : (
							<div
								ref={listRef}
								className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2"
							>
								<div
									className="relative w-full"
									style={{ height: virtualizer.getTotalSize() }}
								>
									{virtualizer.getVirtualItems().map((virtualRow) => {
										const item = visibleItems[virtualRow.index];
										return (
											<div
												key={item.id}
												className="absolute top-0 left-0 w-full pb-2"
												style={{
													transform: `translateY(${virtualRow.start}px)`,
												}}
												ref={virtualizer.measureElement}
												data-index={virtualRow.index}
											>
												<PlazaFeedItemRow
													item={item}
													hideSource={selectedId !== null}
													onOpen={openFeedItem}
													onImport={(item) => void importItem(item)}
													importing={importingIds.has(item.id)}
													onToggleRead={(item) =>
														void setRead(item, !item.readAt)
													}
												/>
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>
				</div>
			)}

			{subMenu ? (
				<FeedSubMenu
					menu={subMenu}
					onClose={closeSubMenu}
					onRename={(sub) => {
						setRenameTarget(sub);
						setRenameTitle(sub.title);
					}}
					onCopyUrl={(sub) =>
						void copyTextToClipboard(sub.url, {
							successMessage: t("plaza.feeds.copiedUrl"),
						})
					}
					onRefresh={(sub) =>
						void feedsRefresh({ id: sub.id }).then((result) => {
							setSubs([...result.subscriptions].sort(compareFeedSubs));
							void loadItems(selectedId);
						})
					}
					onPin={(sub) => void onPin(sub.id, !sub.pinned)}
					onRemove={(sub) => void onRemove(sub.id)}
				/>
			) : null}

			<Dialog
				open={renameTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRenameTarget(null);
				}}
			>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("plaza.feeds.rename")}</DialogTitle>
					</DialogHeader>
					<Input
						value={renameTitle}
						onChange={(event) => setRenameTitle(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void onRename();
							}
						}}
						aria-label={t("plaza.feeds.rename")}
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setRenameTarget(null)}
						>
							{t("plaza.feeds.cancel")}
						</Button>
						<Button type="button" onClick={() => void onRename()}>
							{t("plaza.feeds.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
