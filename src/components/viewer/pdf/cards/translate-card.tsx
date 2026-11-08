import {
	Maximize2Icon,
	Minimize2Icon,
	Pin,
	PinOff,
	Settings2Icon,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ui/shimmer";
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
	/** Dismiss the card; unpinned results are discarded on dismissal. */
	onHide: () => void;
	/** Whether this result and its source marker survive card dismissal. */
	pinned?: boolean;
	/** Toggle whether the result is kept with a persistent source marker. */
	onTogglePin?: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
};

/**
 * PDF selection translation — shared SelectionCard shell with dismiss / pin.
 * Content-sized within the viewport, with native resizing and a keyboard
 * expand/restore action. Long results scroll with a visible scrollbar.
 */
export function TranslateCard({
	screen,
	preferRight = false,
	result,
	streaming,
	error,
	onOpenSettings,
	onHide,
	pinned = false,
	onTogglePin,
	onPointerEnter,
	onPointerLeave,
}: TranslateCardProps) {
	const { t } = useTranslation("viewer");
	const [expanded, setExpanded] = useState(false);
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
			width={expanded ? 680 : 340}
			height={expanded ? 600 : 480}
			// Content-sized: hug the anchor and shrink near viewport edges instead
			// of pre-shifting by the full preferred height.
			trackPin
			lockHeight={expanded}
			resizable
			preferRight={preferRight}
			title={t("selection.translateTitle")}
			ariaLive="polite"
			onDismiss={onHide}
			dismissOnInteractOutside={false}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			// Keep WebKit's native resize corner clear of the nested scrollport.
			className="pb-3"
			actions={[
				{
					id: "resize",
					label: t(
						expanded
							? "selection.translateRestoreSize"
							: "selection.translateExpand",
					),
					onClick: () => setExpanded((value) => !value),
					icon: expanded ? (
						<Minimize2Icon className="size-3.5" />
					) : (
						<Maximize2Icon className="size-3.5" />
					),
				},
				...(onTogglePin
					? [
							{
								label: t(
									pinned
										? "selection.translateUnpin"
										: "selection.translatePin",
								),
								onClick: onTogglePin,
								icon: pinned ? (
									<PinOff className="size-3.5" />
								) : (
									<Pin className="size-3.5" />
								),
								pressed: pinned,
							},
						]
					: []),
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
					<Shimmer className="text-sm" as="p">
						{t("selection.translating")}
					</Shimmer>
				) : null}

				{showResult ? (
					<MessageResponse className="min-w-0 whitespace-pre-wrap break-words text-sm text-foreground leading-snug">
						{result}
					</MessageResponse>
				) : null}

				{!showLoading && !showResult && !error ? (
					<p className="text-muted-foreground text-sm">
						{t("selection.translating")}
					</p>
				) : null}

				{error ? (
					<div className="flex flex-col items-start gap-1.5">
						<p className="text-destructive text-sm" role="alert">
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
