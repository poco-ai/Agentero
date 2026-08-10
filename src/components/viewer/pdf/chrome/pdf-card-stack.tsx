import { createPortal } from "react-dom";
import { AnnotationEditor } from "@/components/viewer/pdf/cards/annotation-editor";
import { AskPopover } from "@/components/viewer/pdf/cards/ask-popover";
import { PdfCitationPreview } from "@/components/viewer/pdf/cards/citation-preview";
import { FormulaAnnotationCard } from "@/components/viewer/pdf/cards/formula-annotation-card";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import { VisualAnnotationEditor } from "@/components/viewer/pdf/cards/visual-annotation-editor";
import { VisualTraceCard } from "@/components/viewer/pdf/cards/visual-trace-card";
import type {
	CardScreenPoint,
	CitationPreviewState,
	EditorState,
	FormulaAnnotationPreviewState,
	SelectionMenuState,
	VisualDraftEditorState,
} from "@/components/viewer/pdf/types";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type { PdfAskThread } from "@/lib/pdf/ask";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

type PdfCardStackProps = {
	selectionMenu: {
		state: SelectionMenuState | null;
		onHighlight: (color: HighlightColor) => void;
		onCopy: () => void;
		onNote: () => void;
		onAsk: () => void;
		onAddToChat: () => void;
		onTranslate: () => void;
		onClose: () => void;
	};
	visualDraft: {
		state: VisualDraftEditorState | null;
		onSave: (comment: string) => void;
		onAddToChat: (comment: string) => void;
		onSendNow: (comment: string) => void;
		/** Discard the pending crop. */
		onDelete: () => void;
		onClose: () => void;
		/** Only wired for ephemeral (layout-hover) drafts. */
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	formulaAnnotation: {
		state: FormulaAnnotationPreviewState | null;
		/** Absent when the paper folder is unknown. */
		onOpenFile?: () => void;
		onClose: () => void;
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	citationPreview: {
		state: CitationPreviewState | null;
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	/** Shared anchor of the pin-attached cards (ask / visual trace / translate). */
	cardScreen: CardScreenPoint | null;
	/** Shared hover-hide contract of the pin-attached cards and the editor. */
	onCardHoverEnter: () => void;
	onCardHoverLeave: () => void;
	ask: {
		thread: PdfAskThread | null;
		streaming: boolean;
		error: string | null;
		onSend: (question: string) => void;
		onResend: (messageId: string, question: string) => void;
		onHide: () => void;
		onDelete: () => void;
		onStop: () => void;
	};
	visualTrace: {
		trace: PdfVisualSessionTrace | null;
		error: string | null;
		initialExpanded: boolean;
		onOpenSession: () => void;
		onAddToChat: () => void;
		onSaveComment: (comment: string) => void;
		onSend: (question: string) => void;
		onDelete: () => void;
		onHide: () => void;
		onStop: () => void;
	};
	translate: {
		record: PdfTranslateRecord | null;
		streaming: boolean;
		error: string | null;
		onOpenSettings: () => void;
		onHide: () => void;
		onDelete: () => void;
	};
	editor: {
		state: EditorState | null;
		onSave: (text: string) => void;
		onClose: () => void;
		onDelete: () => void;
	};
};

/**
 * Floating cards of the viewer, portaled to `document.body` so page transforms
 * and the scroller's overflow never clip or scale them.
 */
export function PdfCardStack({
	selectionMenu,
	visualDraft,
	formulaAnnotation,
	citationPreview,
	cardScreen,
	onCardHoverEnter,
	onCardHoverLeave,
	ask,
	visualTrace,
	translate,
	editor,
}: PdfCardStackProps) {
	if (typeof document === "undefined") return null;

	return createPortal(
		<>
			{selectionMenu.state ? (
				<SelectionMenu
					screen={selectionMenu.state.screen}
					onHighlight={selectionMenu.onHighlight}
					onCopy={selectionMenu.onCopy}
					onNote={selectionMenu.onNote}
					onAsk={selectionMenu.onAsk}
					onAddToChat={selectionMenu.onAddToChat}
					onTranslate={selectionMenu.onTranslate}
					onClose={selectionMenu.onClose}
				/>
			) : null}

			{visualDraft.state ? (
				<VisualAnnotationEditor
					screen={visualDraft.state.screen}
					onSave={visualDraft.onSave}
					onAddToChat={visualDraft.onAddToChat}
					onSendNow={visualDraft.onSendNow}
					onDelete={visualDraft.onDelete}
					onClose={visualDraft.onClose}
					onPointerEnter={
						visualDraft.state.ephemeral ? visualDraft.onHoverEnter : undefined
					}
					onPointerLeave={
						visualDraft.state.ephemeral ? visualDraft.onHoverLeave : undefined
					}
				/>
			) : null}

			{formulaAnnotation.state ? (
				<FormulaAnnotationCard
					screen={formulaAnnotation.state.screen}
					symbols={formulaAnnotation.state.symbols}
					onOpenFile={formulaAnnotation.onOpenFile}
					onClose={formulaAnnotation.onClose}
					onPointerEnter={formulaAnnotation.onHoverEnter}
					onPointerLeave={formulaAnnotation.onHoverLeave}
				/>
			) : null}

			{citationPreview.state ? (
				<PdfCitationPreview
					screen={citationPreview.state.screen}
					previewText={citationPreview.state.previewText}
					onPointerEnter={citationPreview.onHoverEnter}
					onPointerLeave={citationPreview.onHoverLeave}
				/>
			) : null}

			{ask.thread && cardScreen ? (
				<AskPopover
					thread={ask.thread}
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

			{visualTrace.trace && cardScreen ? (
				<VisualTraceCard
					trace={visualTrace.trace}
					screen={cardScreen}
					preferRight={cardScreen.preferRight ?? true}
					error={visualTrace.error}
					initialExpanded={visualTrace.initialExpanded}
					onOpenSession={visualTrace.onOpenSession}
					onAddToChat={visualTrace.onAddToChat}
					onSaveComment={visualTrace.onSaveComment}
					onSend={visualTrace.onSend}
					onDelete={visualTrace.onDelete}
					onHide={visualTrace.onHide}
					onPointerEnter={onCardHoverEnter}
					onPointerLeave={onCardHoverLeave}
					onStop={visualTrace.onStop}
				/>
			) : null}

			{translate.record && cardScreen ? (
				<TranslateCard
					screen={cardScreen}
					preferRight={cardScreen.preferRight ?? true}
					result={translate.record.result ?? ""}
					streaming={translate.streaming}
					error={translate.error ?? translate.record.error ?? null}
					onOpenSettings={translate.onOpenSettings}
					onHide={translate.onHide}
					onDelete={translate.onDelete}
					onPointerEnter={onCardHoverEnter}
					onPointerLeave={onCardHoverLeave}
				/>
			) : null}

			{editor.state ? (
				<AnnotationEditor
					screen={editor.state.screen}
					initialComment={editor.state.comment}
					onSave={editor.onSave}
					onClose={editor.onClose}
					onDelete={editor.onDelete}
					onPointerEnter={onCardHoverEnter}
					onPointerLeave={onCardHoverLeave}
				/>
			) : null}
		</>,
		document.body,
	);
}
