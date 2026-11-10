import { SelectionSurface } from "@/components/selection/selection-surface";
/**
 * Feed timeline card + in-panel detail. Import is available from the card
 * context menu and detail toolbar. Detail body supports selection Ask /
 * Add-to-chat (ephemeral).
 */

import {
	ArrowLeft,
	Check,
	Download,
	ExternalLink,
	Loader2,
	Mail,
	MailOpen,
	MessageSquarePlus,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { addFeedItemToChat } from "@/lib/plaza/feed-chat";
import { beginFeedItemDrag } from "@/lib/plaza/feed-drag";
import {
	cleanFeedSummary,
	type FeedItem,
	feedDetailMarkdown,
	feedsResolveBody,
	formatFeedWhen,
} from "@/lib/plaza/feeds";

export function PlazaFeedItemRow({
	item,
	hideSource,
	onOpen,
	onToggleRead,
	onImport,
	importing,
}: {
	item: FeedItem;
	hideSource: boolean;
	onOpen: (item: FeedItem) => void;
	onToggleRead: (item: FeedItem) => void;
	onImport: (item: FeedItem) => void;
	importing: boolean;
}) {
	const { t, i18n } = useTranslation("sidebar");
	const when = formatFeedWhen(item.publishedAt, i18n.language);
	const summary = cleanFeedSummary(item.summaryText);
	const href = item.url?.trim() || item.paperUrl?.trim();

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<article
					draggable
					onDragStart={(event) => beginFeedItemDrag(event.dataTransfer, item)}
					className={cn(
						"group relative flex items-start gap-2 rounded-xl p-3",
						"transition-[background-color] duration-200 ease-out",
						item.readAt
							? "bg-muted/50 hover:bg-muted/70"
							: "bg-muted hover:bg-accent",
					)}
				>
					<button
						type="button"
						onClick={() => onOpen(item)}
						className={cn(
							"block min-w-0 flex-1 text-left",
							item.readAt && "text-muted-foreground",
							"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						)}
					>
						<span className="sr-only">
							{t(item.readAt ? "plaza.feeds.read" : "plaza.feeds.unread")}
						</span>
						{hideSource ? (
							<div className="flex items-baseline gap-2">
								<span
									className={cn(
										"min-w-0 truncate text-sm",
										!item.readAt && "font-medium",
									)}
								>
									{item.title}
								</span>
								{when ? (
									<span className="shrink-0 text-muted-foreground text-xs">
										{when}
									</span>
								) : null}
							</div>
						) : (
							<>
								<div
									className={cn(
										"truncate text-sm",
										!item.readAt && "font-medium",
									)}
								>
									{item.title}
								</div>
								<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
									<span className="truncate">{item.subscriptionTitle}</span>
									{when ? (
										<>
											<span aria-hidden>·</span>
											<span className="shrink-0">{when}</span>
										</>
									) : null}
								</div>
							</>
						)}
						{summary ? (
							<p className="mt-1 line-clamp-3 text-muted-foreground text-xs leading-snug">
								{summary}
							</p>
						) : null}
					</button>
					<div className="flex shrink-0 flex-col items-center gap-0.5">
						<FeedReadButton item={item} onClick={() => onToggleRead(item)} />
						{href ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 focus-visible:opacity-100"
										aria-label={t("plaza.feeds.openOriginal")}
										onClick={(event) => {
											event.stopPropagation();
											openExternalUrl(href);
										}}
									>
										<ExternalLink className="size-3.5" aria-hidden />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("plaza.feeds.openOriginal")}</TooltipContent>
							</Tooltip>
						) : null}
					</div>
				</article>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onSelect={() => addFeedItemToChat(item)}>
					<MessageSquarePlus aria-hidden />
					{t("plaza.feeds.addToChat")}
				</ContextMenuItem>
				<ContextMenuItem
					disabled={importing || Boolean(item.importedAt) || !href}
					onSelect={() => onImport(item)}
				>
					{item.importedAt ? (
						<Check aria-hidden />
					) : importing ? (
						<Loader2 className="animate-spin" aria-hidden />
					) : (
						<Download aria-hidden />
					)}
					{t(item.importedAt ? "plaza.feeds.imported" : "plaza.feeds.import")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function PlazaFeedItemDetail({
	item,
	hideSource,
	onBack,
	onImport,
	importing,
	onResolved,
	onToggleRead,
}: {
	item: FeedItem;
	hideSource: boolean;
	onBack: () => void;
	onImport: (item: FeedItem) => void;
	importing: boolean;
	onResolved: (next: FeedItem) => void;
	onToggleRead: () => void;
}) {
	const { t, i18n } = useTranslation("sidebar");
	const [resolving, setResolving] = useState(!item.bodyMarkdown);
	const when = formatFeedWhen(item.publishedAt, i18n.language);
	const href = item.url?.trim() || item.paperUrl?.trim();
	const imported = Boolean(item.importedAt);
	const canImport = Boolean(item.paperUrl?.trim() || item.url?.trim());
	const markdown = feedDetailMarkdown(item);

	useEffect(() => {
		if (item.bodyMarkdown?.trim()) {
			setResolving(false);
			return;
		}
		let cancelled = false;
		setResolving(true);
		void feedsResolveBody(item.id)
			.then((next) => {
				if (!cancelled) onResolved(next);
			})
			.catch(() => {
				/* keep the RSS excerpt already on screen */
			})
			.finally(() => {
				if (!cancelled) setResolving(false);
			});
		return () => {
			cancelled = true;
		};
	}, [item.bodyMarkdown, item.id, onResolved]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 select-none items-center gap-1 px-2.5 py-2">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("plaza.feeds.back")}
							onClick={onBack}
						>
							<ArrowLeft className="size-3.5" aria-hidden />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.feeds.back")}</TooltipContent>
				</Tooltip>
				<div className="flex min-w-0 flex-1 items-center gap-1">
					<span className="min-w-0 truncate text-muted-foreground text-xs tracking-[0.01em]">
						{[hideSource ? null : item.subscriptionTitle, when]
							.filter(Boolean)
							.join(" · ")}
					</span>
					{href ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={t("plaza.feeds.openOriginal")}
									onClick={() => openExternalUrl(href)}
								>
									<ExternalLink className="size-3.5" aria-hidden />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("plaza.feeds.openOriginal")}</TooltipContent>
						</Tooltip>
					) : null}
				</div>
				<FeedReadButton item={item} onClick={onToggleRead} />
				{resolving ? (
					<Loader2
						className="size-3.5 shrink-0 animate-spin text-muted-foreground"
						aria-label={t("plaza.feeds.loadingBody")}
					/>
				) : null}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("plaza.feeds.addToChat")}
							onClick={() => addFeedItemToChat(item)}
						>
							<MessageSquarePlus className="size-3.5" aria-hidden />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.feeds.addToChat")}</TooltipContent>
				</Tooltip>
				{canImport ? (
					imported ? (
						<span className="inline-flex items-center gap-0.5 pr-1 text-muted-foreground text-xs">
							<Check className="size-3" aria-hidden />
							{t("plaza.feeds.imported")}
						</span>
					) : (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={importing}
									aria-label={t("plaza.feeds.import")}
									onClick={() => onImport(item)}
								>
									{importing ? (
										<Loader2 className="size-3.5 animate-spin" aria-hidden />
									) : (
										<Download className="size-3.5" aria-hidden />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("plaza.feeds.import")}</TooltipContent>
						</Tooltip>
					)
				) : null}
			</div>
			<SelectionSurface
				source={{
					sourcePath: href || `agentero:plaza/feeds/${item.id}`,
					sourceUrl: href,
					sourceTitle: item.title,
					origin: "markdown",
					surface: "feed",
				}}
				autoCopy
				className="agentero-scroll min-h-0 flex-1 select-text overflow-y-auto px-6 py-5"
			>
				{markdown ? (
					<MessageResponse className="prose prose-sm dark:prose-invert mx-auto max-w-[68ch] text-sm leading-relaxed [&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:font-medium [&_h1]:text-base [&_h1]:leading-snug">
						{markdown}
					</MessageResponse>
				) : null}
			</SelectionSurface>
		</div>
	);
}

function FeedReadButton({
	item,
	onClick,
}: {
	item: FeedItem;
	onClick: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const label = t(
		item.readAt ? "plaza.feeds.markUnread" : "plaza.feeds.markRead",
	);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={label}
					onClick={onClick}
				>
					{item.readAt ? (
						<MailOpen className="size-3.5 text-muted-foreground" aria-hidden />
					) : (
						<Mail className="size-3.5" aria-hidden />
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
