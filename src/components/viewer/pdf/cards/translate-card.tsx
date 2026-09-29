import { Settings2Icon, Trash2Icon, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";

type TranslateCardProps = {
	screen: ScreenPoint;
	preferRight?: boolean;
	/** Translation text (may stream in) */
	result: string;
	streaming: boolean;
	error: string | null;
	/** Open Translate settings from an API failure state. */
	onOpenSettings: () => void;
	/** Hide the card without deleting its saved translation. */
	onHide: () => void;
	/** Delete the persisted translate record. */
	onDelete: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
};

/**
 * PDF selection translation — shared SelectionCard shell with dismiss / delete.
 * Content-sized up to a generous cap so long paragraphs read in full; only
 * results that overflow the cap (or the viewport) scroll, with an always
 * visible scrollbar so the overflow is discoverable.
 */
export function TranslateCard({
	screen,
	preferRight = false,
	result,
	streaming,
	error,
	onOpenSettings,
	onHide,
	onDelete,
	onPointerEnter,
	onPointerLeave,
}: TranslateCardProps) {
	const { t } = useTranslation("viewer");
	const showResult = result.trim().length > 0;
	const showLoading = streaming && !showResult;
	const scrollPortRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);

	const handleScroll = () => {
		const el = scrollPortRef.current;
		if (!el) return;
		stickToBottomRef.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < 24;
	};

	// Follow the stream tail so late chunks stay visible once the card hits its
	// cap; a manual scroll-up detaches until the next run.
	// biome-ignore lint/correctness/useExhaustiveDependencies: result is the re-run trigger for new chunks, not a value read inside
	useEffect(() => {
		const el = scrollPortRef.current;
		if (!el || !streaming || !stickToBottomRef.current) return;
		el.scrollTop = el.scrollHeight;
	}, [result, streaming]);

	return (
		<SelectionCard
			screen={screen}
			width={340}
			height={480}
			// Content-sized: hug the anchor and shrink near viewport edges instead
			// of pre-shifting by the full preferred height.
			trackPin
			preferRight={preferRight}
			title={t("selection.translateTitle")}
			ariaLive="polite"
			onDismiss={onHide}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			actions={[
				{
					label: t("selection.translateDelete"),
					onClick: onDelete,
					icon: <Trash2Icon className="size-3.5" />,
					destructive: true,
				},
				{
					label: t("selection.translateHide"),
					onClick: onHide,
					icon: <X className="size-3.5" />,
				},
			]}
			// Body only constrains flex; the translation owns its own scrollport.
			bodyClassName="min-h-0 overflow-hidden p-0"
		>
			<div
				ref={scrollPortRef}
				onScroll={handleScroll}
				className="agentero-scroll agentero-scroll-visible flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden overflow-y-auto px-2.5 py-2"
			>
				{showLoading ? (
					<Shimmer className="text-xs" as="p">
						{t("selection.translating")}
					</Shimmer>
				) : null}

				{showResult ? (
					<MessageResponse className="min-w-0 whitespace-pre-wrap break-words text-xs text-foreground leading-snug">
						{result}
					</MessageResponse>
				) : null}

				{!showLoading && !showResult && !error ? (
					<p className="text-muted-foreground text-xs">
						{t("selection.translating")}
					</p>
				) : null}

				{error ? (
					<div className="flex flex-col items-start gap-1.5">
						<p className="text-destructive text-xs" role="alert">
							{error}
						</p>
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="gap-1 px-1.5"
							onClick={onOpenSettings}
						>
							<Settings2Icon className="size-3" />
							{t("selection.translateOpenSettings")}
						</Button>
					</div>
				) : null}
			</div>
		</SelectionCard>
	);
}
