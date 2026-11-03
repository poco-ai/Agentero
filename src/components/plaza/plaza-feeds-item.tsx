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
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import { PlazaSelectionMenu } from "@/components/plaza/plaza-selection-menu";
import { usePlazaFeedSelection } from "@/components/plaza/use-plaza-feed-selection";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SelectionCopiedLabel } from "@/components/ui/selection-copied-label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { AskPopover } from "@/components/viewer/pdf/cards/ask-popover";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import {
	cleanFeedSummary,
	type FeedItem,
	feedDetailMarkdown,
	feedsResolveBody,
} from "@/lib/plaza/feeds";

export function formatFeedWhen(iso: string | null, locale: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
	const abs = Math.abs(diffSec);
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (abs < 60) return rtf.format(diffSec, "second");
	if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
	if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), "day");
	return new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
	}).format(date);
}

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
				<div
					className={cn(
						"group relative rounded-lg border bg-background p-2.5",
						"transition-colors hover:border-foreground/20 hover:bg-muted/50",
					)}
				>
					<button
						type="button"
						onClick={() => onOpen(item)}
						className={cn(
							"block w-full min-w-0 pr-16 text-left",
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
					<div className="absolute top-2 right-10">
						<FeedReadButton item={item} onClick={() => onToggleRead(item)} />
					</div>
					{href ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
			</ContextMenuTrigger>
			<ContextMenuContent>
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
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const when = formatFeedWhen(item.publishedAt, i18n.language);
	const href = item.url?.trim() || item.paperUrl?.trim();
	const imported = Boolean(item.importedAt);
	const canImport = Boolean(item.paperUrl?.trim() || item.url?.trim());
	const markdown = feedDetailMarkdown(item);
	const selection = usePlazaFeedSelection({ item, bodyRef });

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
			<div className="flex shrink-0 select-none items-center gap-1 border-b px-2 py-1.5">
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
				<span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
					{[hideSource ? null : item.subscriptionTitle, when]
						.filter(Boolean)
						.join(" · ")}
				</span>
				<FeedReadButton item={item} onClick={onToggleRead} />
				{resolving ? (
					<Loader2
						className="size-3.5 shrink-0 animate-spin text-muted-foreground"
						aria-label={t("plaza.feeds.loadingBody")}
					/>
				) : null}
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
			<div
				ref={bodyRef}
				className="agentero-scroll min-h-0 flex-1 select-text overflow-y-auto px-5 py-4"
			>
				{markdown ? (
					<MessageResponse className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed [&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:font-medium [&_h1]:text-base [&_h1]:leading-snug">
						{markdown}
					</MessageResponse>
				) : null}
			</div>
			{selection.menu && !selection.ask ? (
				<PlazaSelectionMenu
					screen={selection.menu.screen}
					onAsk={selection.handleAsk}
					onAddToChat={selection.handleAddToChat}
				/>
			) : null}
			{selection.copiedLabelPos ? (
				<SelectionCopiedLabel
					x={selection.copiedLabelPos.x}
					y={selection.copiedLabelPos.y}
				/>
			) : null}
			{selection.ask ? (
				<div data-plaza-ask-card>
					<AskPopover
						thread={selection.ask.thread}
						paperTitle={selection.itemTitle}
						paperLink={selection.itemLink}
						screen={selection.ask.screen}
						streaming={selection.streaming}
						error={selection.askError}
						onSend={selection.sendAskQuestion}
						onResend={selection.resendAskQuestion}
						onHide={selection.hideAsk}
						onDelete={selection.deleteAsk}
						onStop={selection.stopAskStreaming}
					/>
				</div>
			) : null}
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
