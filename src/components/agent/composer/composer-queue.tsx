import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	Queue,
	QueueItem,
	QueueItemAction,
	QueueItemActions,
	QueueItemContent,
	QueueItemIndicator,
	QueueList,
	QueueSection,
	QueueSectionContent,
	QueueSectionLabel,
	QueueSectionTrigger,
} from "@/components/agent/elements/queue";
import { InlineChipText } from "@/components/agent/inline-chip-text";
import type { QueuedPrompt } from "@/components/agent/types";
import {
	hasTranscriptChips,
	inlineMarkupToPlain,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import { cn } from "@/lib/core/utils";

export function ComposerQueue({
	messageQueue,
	onRemoveQueuedMessage,
	compact = false,
}: {
	messageQueue: QueuedPrompt[];
	onRemoveQueuedMessage: (id: string) => void;
	compact?: boolean;
}) {
	const { t } = useTranslation("agent");
	if (messageQueue.length === 0) return null;
	return (
		<Queue
			className={cn(
				"shrink-0 shadow-none",
				compact && "gap-1 px-2 pt-1.5 pb-1.5",
			)}
		>
			<QueueSection defaultOpen>
				<QueueSectionTrigger
					className={cn(compact && "rounded-sm px-2 py-1 text-xs")}
				>
					<QueueSectionLabel
						count={messageQueue.length}
						label={t("composer.queueLabel")}
						className={cn(compact && "gap-1.5")}
					/>
				</QueueSectionTrigger>
				<QueueSectionContent>
					<QueueList className={cn(compact && "mt-1")}>
						{messageQueue.map((item) => {
							const imageCount = item.images?.length ?? 0;
							const chipMarkup = hasTranscriptChips(item.text)
								? item.text
								: undefined;
							const queueLabel =
								(chipMarkup
									? inlineMarkupToPlain(chipMarkup)
									: stripInlineTokens(item.text).trim()) ||
								(item.visualDrafts.length
									? t("composer.visualAnnotationsTitle", {
											count: item.visualDrafts.length,
										})
									: imageCount > 0
										? t("composer.attachedImagesTitle", {
												count: imageCount,
											})
										: t("composer.visualAnnotation"));
							return (
								<QueueItem
									key={item.id}
									className={cn(compact && "px-2 py-0.5 text-xs")}
								>
									<div className="flex w-full items-center gap-2">
										<QueueItemIndicator />
										<QueueItemContent title={queueLabel}>
											{chipMarkup ? (
												<InlineChipText markup={chipMarkup} />
											) : (
												queueLabel
											)}
										</QueueItemContent>
										<QueueItemActions>
											<QueueItemAction
												aria-label={t("composer.queueRemove")}
												title={t("composer.queueRemove")}
												onClick={() => onRemoveQueuedMessage(item.id)}
											>
												<X className="size-3.5" />
											</QueueItemAction>
										</QueueItemActions>
									</div>
								</QueueItem>
							);
						})}
					</QueueList>
				</QueueSectionContent>
			</QueueSection>
		</Queue>
	);
}
