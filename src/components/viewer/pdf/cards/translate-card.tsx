import {
	Check,
	Copy,
	CornerUpLeft,
	Pin,
	PinOff,
	Settings2Icon,
	X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ui/shimmer";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import { isEditableClipboardTarget } from "@/components/viewer/pdf/host-dom";
import type { CardScreenPoint } from "@/components/viewer/pdf/types";
import { copyTextToClipboard } from "@/lib/core/clipboard";

const TRANSLATE_CARD_WIDTH = 340;
const TRANSLATE_CARD_MIN_WIDTH = 220;
const TRANSLATE_CARD_HEIGHT = 480;

type TranslateCardProps = {
	screen: CardScreenPoint;
	preferRight?: boolean;
	source?: {
		quote?: string;
		page?: number;
		title?: string;
		onLocate: () => void;
	};
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

function LocateSourceButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<TooltipProvider delayDuration={200} disableHoverableContent>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={label}
						className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						onClick={onClick}
					>
						<CornerUpLeft className="size-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="left">{label}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

/**
 * Quote split at the first rendered line break. Line 1 keeps the full source
 * width; only line 2 loses room for the return icon.
 */
type QuoteLines = { first: string; second: string | null };

/**
 * PDF selection translation — shared SelectionCard shell with dismiss / pin.
 * Content-sized up to a generous cap so long paragraphs read in full; only
 * results that overflow the cap (or the viewport) scroll, with an always
 * visible scrollbar so the overflow is discoverable.
 */
export function TranslateCard({
	screen,
	preferRight = false,
	source,
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
	const showResult = result.trim().length > 0;
	const showLoading = streaming && !showResult;
	const scrollPortRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);
	const [copied, setCopied] = useState(false);
	const quoteText = source
		? source.quote?.trim() || t("selection.sourcePage", { page: source.page })
		: "";
	const quoteMeasureRef = useRef<HTMLParagraphElement>(null);
	const [quoteLines, setQuoteLines] = useState<QuoteLines | null>(null);

	useLayoutEffect(() => {
		const el = quoteMeasureRef.current;
		if (!el) return;
		const measure = () => {
			const node = el.firstChild;
			let next: QuoteLines = { first: quoteText, second: null };
			const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
			if (
				node?.nodeType === Node.TEXT_NODE &&
				Number.isFinite(lineHeight) &&
				lineHeight > 0 &&
				el.clientHeight > lineHeight * 1.5
			) {
				const textNode = node as Text;
				const secondTop = el.getBoundingClientRect().top + lineHeight;
				let low = 0;
				let high = quoteText.length;
				while (low < high) {
					const mid = Math.floor((low + high) / 2);
					const caret = document.createRange();
					caret.setStart(textNode, mid);
					caret.collapse(true);
					if (caret.getBoundingClientRect().top >= secondTop - 0.5) {
						high = mid;
					} else {
						low = mid + 1;
					}
				}
				let split = low;
				// Do not split a surrogate pair.
				if (split > 0) {
					const code = quoteText.charCodeAt(split - 1);
					if (code >= 0xd800 && code <= 0xdbff) split += 1;
				}
				if (split > 0 && split < quoteText.length) {
					const first = quoteText.slice(0, split).trimEnd();
					const second = quoteText.slice(split).trimStart();
					if (first && second) next = { first, second };
				}
			}
			setQuoteLines((prev) =>
				prev?.first === next.first && prev?.second === next.second
					? prev
					: next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [quoteText]);

	/** Smallest height that still shows the header and source quote. */
	const [resizeMinHeight, setResizeMinHeight] = useState<number>();

	useEffect(() => {
		// This nonmodal card stays open when focus leaves it. Scope the keys to
		// its mounted lifetime and leave native editing and other dialogs alone.
		const onKeyDown = (event: KeyboardEvent) => {
			const action =
				event.key === "Escape"
					? onHide
					: event.key.toLowerCase() === "p"
						? onTogglePin
						: undefined;
			if (
				!action ||
				event.defaultPrevented ||
				event.isComposing ||
				event.repeat ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey ||
				isEditableClipboardTarget(event.target)
			)
				return;
			const overlay =
				event.target instanceof Element
					? event.target.closest(
							"[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
						)
					: null;
			if (overlay && !overlay.contains(scrollPortRef.current)) return;
			event.preventDefault();
			action();
		};
		// Capture before the card's action tooltip can consume Escape.
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onHide, onTogglePin]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	const copyResult = async () => {
		const ok = await copyTextToClipboard(result.trim(), {
			errorMessage: t("selection.translateCopyFailed"),
		});
		if (ok) setCopied(true);
	};

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

	// Keep the source context visible when the card is shrunk: the floor is
	// everything above the translation scrollport (header + quote + margins).
	useEffect(() => {
		const port = scrollPortRef.current;
		const card = port?.closest<HTMLElement>('[role="dialog"]');
		if (!port || !card) return;
		const measure = () => {
			setResizeMinHeight(Math.ceil(card.offsetHeight - port.clientHeight));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(card);
		observer.observe(port);
		return () => observer.disconnect();
	}, []);

	return (
		<SelectionCard
			screen={screen}
			width={TRANSLATE_CARD_WIDTH}
			height={TRANSLATE_CARD_HEIGHT}
			// Content-sized: hug the anchor and shrink near viewport edges instead
			// of pre-shifting by the full preferred height.
			trackPin
			draggable
			resizable
			resizeMinWidth={TRANSLATE_CARD_MIN_WIDTH}
			resizeMaxWidth={TRANSLATE_CARD_WIDTH}
			// Never shrink past the header + source quote (0 until measured).
			resizeMinHeight={resizeMinHeight ?? 0}
			preferRight={preferRight}
			preferBelow
			// Slightly tighter header than other selection cards.
			headerClassName="pt-2 pb-1.5"
			title={t("selection.translateTitle")}
			ariaLive="polite"
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			actions={[
				...(showResult
					? [
							{
								id: "copy",
								label: t(copied ? "selection.copied" : "selection.copy"),
								onClick: () => void copyResult(),
								icon: copied ? <Check /> : <Copy />,
							},
						]
					: []),
				...(onTogglePin
					? [
							{
								id: "pin",
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
								shortcut: "P",
							},
						]
					: []),
				{
					label: t("selection.translateHide"),
					onClick: onHide,
					icon: <X className="size-3.5" />,
					shortcut: "Escape",
				},
			]}
			// Body only constrains flex; the translation owns its own scrollport.
			bodyClassName="min-h-0 overflow-hidden p-0"
		>
			{source ? (
				<div className="mx-3 mt-2.5 flex min-h-6 shrink-0 flex-col justify-end gap-0.5 border-border/60 border-l-2 pr-2.5 pl-2.5 text-muted-foreground">
					{source.title && (
						<button
							type="button"
							className="mb-0.5 truncate text-left font-medium text-[11px] tracking-[0.01em] hover:text-foreground"
							onClick={source.onLocate}
						>
							{source.title}
						</button>
					)}
					<div className="relative">
						<p
							ref={quoteMeasureRef}
							aria-hidden
							className="pointer-events-none invisible absolute inset-x-0 top-0 break-words text-xs leading-relaxed"
						>
							{quoteText}
						</p>
						{quoteLines?.second ? (
							<>
								<p className="break-words text-xs leading-relaxed">
									{quoteLines.first}
								</p>
								<div className="flex items-center gap-1.5">
									<p className="min-w-0 flex-1 truncate text-xs leading-relaxed">
										{quoteLines.second}
									</p>
									<LocateSourceButton
										label={t("selection.locateSource")}
										onClick={source.onLocate}
									/>
								</div>
							</>
						) : (
							<div className="flex items-center gap-1.5">
								<p className="line-clamp-2 min-w-0 flex-1 break-words text-xs leading-relaxed">
									{quoteLines?.first ?? quoteText}
								</p>
								<LocateSourceButton
									label={t("selection.locateSource")}
									onClick={source.onLocate}
								/>
							</div>
						)}
					</div>
				</div>
			) : null}
			<div
				ref={scrollPortRef}
				onScroll={handleScroll}
				className="agentero-scroll agentero-scroll-visible mx-3 mt-2 mb-2.5 flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden overflow-y-auto py-0.5 pr-0.5"
			>
				{showLoading ? (
					<Shimmer className="text-sm" as="p">
						{t("selection.translating")}
					</Shimmer>
				) : null}

				{showResult ? (
					<MessageResponse className="min-w-0 whitespace-pre-wrap break-words text-[0.9375rem] text-foreground leading-relaxed">
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
