import { AnimatePresence } from "motion/react";
import { memo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AskPopover } from "@/components/viewer/pdf/cards/ask-popover";
import {
	type CitationPreviewImportMenu,
	PdfCitationPreview,
} from "@/components/viewer/pdf/cards/citation-preview";
import { PdfCrossrefPreview } from "@/components/viewer/pdf/cards/crossref-preview";
import { PdfLinkUrlTip } from "@/components/viewer/pdf/cards/link-url-tip";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import { VisualTraceCard } from "@/components/viewer/pdf/cards/visual-trace-card";
import type { LinkUrlTipState } from "@/components/viewer/pdf/hooks/use-pdf-link-url-tip";
import type {
	CardScreenPoint,
	CitationPreviewState,
	CrossrefPreviewState,
	SelectionMenuState,
} from "@/components/viewer/pdf/types";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type { PdfAskThread } from "@/lib/pdf/ask";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import type { MenuContext } from "@/lib/shell/commands/menu-contributions";

type PdfCardStackProps = {
	selectionMenu: {
		state: SelectionMenuState | null;
		onHighlight: (color: HighlightColor, shape: PdfTextMarkupKind) => void;
		onAsk: () => void;
		onAddToChat: () => void;
		onTranslate: () => void;
		onCopy?: () => Promise<boolean>;
		onBookmark?: () => void;
		onNote?: (shape: PdfTextMarkupKind) => void;
		/** Hide highlight / translate (no marks/ to persist into); keep Ask. */
		showHighlight?: boolean;
		showTranslate?: boolean;
		/** Passed through to the PDF toolbar. Omitted by other SelectionMenu callers. */
		contributionContext?: MenuContext;
	};
	citationPreview: {
		state: CitationPreviewState | null;
		importMenu?: CitationPreviewImportMenu;
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	crossrefPreview: {
		state: CrossrefPreviewState | null;
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	linkUrlTip: {
		state: LinkUrlTipState | null;
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	/** Shared anchor of the pin-attached cards (ask / translate). */
	cardScreen: CardScreenPoint | null;
	/** Shared hover-hide contract of the pin-attached cards. */
	onCardHoverEnter: () => void;
	onCardHoverLeave: () => void;
	ask: {
		thread: PdfAskThread | null;
		/** Catalog title for the external "open in chat" query. */
		paperTitle?: string;
		/** Catalog arXiv / source link for the external "open in chat" query. */
		paperLink?: string;
		streaming: boolean;
		error: string | null;
		onSend: (question: string) => void;
		onResend: (messageId: string, question: string) => void;
		onHide: () => void;
		onDelete: () => void;
		onStop: () => void;
	};
	translate: {
		record: PdfTranslateRecord | null;
		streaming: boolean;
		error: string | null;
		onOpenSettings: () => void;
		onTogglePin?: () => void;
		onHide: () => void;
	};
	visual: {
		trace: PdfVisualSessionTrace | null;
		onHide: () => void;
		onDelete: () => void;
	};
};

/** Stable across scroll re-place; changes when the selection itself changes. */
function selectionMenuInstanceKey(state: SelectionMenuState): string {
	const rect = state.anchor.rects[0];
	if (!rect) return String(state.anchor.page);
	return `${state.anchor.page}:${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
}

/**
 * Clip page-anchored cards to the reading area. The wrapper is window-sized
 * (`inset-0`) so the card keeps its client coordinates, and `clip-path` makes
 * it the containing block for the fixed card — without it the card would keep
 * painting over the tab strip once its text scrolls above the viewport.
 */
function PageClip({
	inset,
	children,
}: {
	inset: CardScreenPoint["clipInset"];
	children: ReactNode;
}) {
	if (!inset) return <>{children}</>;
	return (
		<div
			className="pointer-events-none fixed inset-0 z-50 [&>*]:pointer-events-auto"
			style={{
				clipPath: `inset(${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px)`,
			}}
		>
			{children}
		</div>
	);
}

/**
 * Floating cards of the viewer, portaled to `document.body` so page transforms
 * and the scroller's overflow never clip them. Cards keep a fixed UI size and
 * type scale at any PDF zoom; their screen anchors still follow the page.
 */
export const PdfCardStack = memo(function PdfCardStack({
	selectionMenu,
	citationPreview,
	crossrefPreview,
	linkUrlTip,
	cardScreen,
	onCardHoverEnter,
	onCardHoverLeave,
	ask,
	translate,
	visual,
}: PdfCardStackProps) {
	if (typeof document === "undefined") return null;

	return createPortal(
		<div>
			{selectionMenu.state ? (
				<SelectionMenu
					key={selectionMenuInstanceKey(selectionMenu.state)}
					screen={selectionMenu.state.screen}
					onHighlight={selectionMenu.onHighlight}
					onAsk={selectionMenu.onAsk}
					onAddToChat={selectionMenu.onAddToChat}
					onTranslate={selectionMenu.onTranslate}
					onCopy={selectionMenu.onCopy}
					onBookmark={selectionMenu.onBookmark}
					onNote={selectionMenu.onNote}
					showHighlight={selectionMenu.showHighlight}
					showTranslate={selectionMenu.showTranslate}
					contributionContext={selectionMenu.contributionContext}
				/>
			) : null}

			{citationPreview.state ? (
				<PdfCitationPreview
					screen={citationPreview.state.screen}
					matched={citationPreview.state.matched}
					importMenu={citationPreview.importMenu}
					onPointerEnter={citationPreview.onHoverEnter}
					onPointerLeave={citationPreview.onHoverLeave}
				/>
			) : null}

			{crossrefPreview.state ? (
				<PdfCrossrefPreview
					screen={crossrefPreview.state.screen}
					kind={crossrefPreview.state.kind}
					page={crossrefPreview.state.page}
					image={crossrefPreview.state.image}
					targetSize={crossrefPreview.state.targetSize}
					onPointerEnter={crossrefPreview.onHoverEnter}
					onPointerLeave={crossrefPreview.onHoverLeave}
				/>
			) : null}

			{linkUrlTip.state ? (
				<PdfLinkUrlTip
					url={linkUrlTip.state.url}
					screen={linkUrlTip.state.screen}
					onPointerEnter={linkUrlTip.onHoverEnter}
					onPointerLeave={linkUrlTip.onHoverLeave}
				/>
			) : null}

			<AnimatePresence>
				{ask.thread && cardScreen ? (
					<AskPopover
						key={`ask-${ask.thread.id}`}
						thread={ask.thread}
						paperTitle={ask.paperTitle}
						paperLink={ask.paperLink}
						screen={cardScreen}
						preferRight={cardScreen.preferRight ?? true}
						streaming={ask.streaming}
						error={ask.error}
						onSend={ask.onSend}
						onResend={ask.onResend}
						onHide={ask.onHide}
						onDelete={ask.onDelete}
						onPointerEnter={onCardHoverEnter}
						onPointerLeave={onCardHoverLeave}
						onStop={ask.onStop}
					/>
				) : null}
			</AnimatePresence>

			{translate.record && cardScreen ? (
				<PageClip inset={cardScreen.clipInset}>
					<TranslateCard
						key={`translate-${translate.record.id}`}
						screen={cardScreen}
						preferRight={cardScreen.preferRight ?? false}
						result={translate.record.result ?? ""}
						streaming={translate.streaming}
						error={translate.error ?? translate.record.error ?? null}
						pinned={translate.record.pinned}
						onTogglePin={translate.onTogglePin}
						onOpenSettings={translate.onOpenSettings}
						onHide={translate.onHide}
						onPointerEnter={onCardHoverEnter}
						onPointerLeave={onCardHoverLeave}
					/>
				</PageClip>
			) : null}

			<AnimatePresence>
				{visual.trace && cardScreen ? (
					<VisualTraceCard
						key={`visual-${visual.trace.id}`}
						trace={visual.trace}
						screen={cardScreen}
						preferRight={cardScreen.preferRight ?? true}
						onHide={visual.onHide}
						onDelete={visual.onDelete}
						onPointerEnter={onCardHoverEnter}
						onPointerLeave={onCardHoverLeave}
					/>
				) : null}
			</AnimatePresence>
		</div>,
		document.body,
	);
});
