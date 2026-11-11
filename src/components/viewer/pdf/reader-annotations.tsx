import { Highlighter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	CommentCard,
	estimateCommentCardHeight,
	SelectionCommentAffordance,
} from "@/components/viewer/pdf/layers/comment-cards-layer";
import type { PdfPageHandlers } from "@/components/viewer/pdf/layers/page-layers";
import type {
	PageAnnotationComment,
	SelectionCommentDraft,
} from "@/components/viewer/pdf/types";
import {
	HIGHLIGHT_HEX,
	normalizeHighlightColor,
} from "@/lib/pdf/highlight/palette";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";

export type ReaderAnnotationControls = {
	highlights: readonly PdfHighlight[];
	draft: SelectionCommentDraft | null;
	editingId: string | null;
	wikiTarget: string | null;
	handlers: Pick<
		PdfPageHandlers,
		| "onOpenComment"
		| "onSaveComment"
		| "onCancelComment"
		| "onDeleteComment"
		| "onCopyCommentLink"
		| "onCopyCommentEmbed"
		| "onAddCommentToChat"
		| "onHoverComment"
		| "onLeaveComment"
		| "onCommitSelectionComment"
		| "onSelectionCommentActiveChange"
		| "onDismissSelectionComment"
	>;
};

/** Reuses the PDF's note editor and annotation writers; no parallel note store. */
export function ReaderAnnotations({
	highlights,
	draft,
	editingId,
	wikiTarget,
	handlers,
}: ReaderAnnotationControls) {
	const { t } = useTranslation("viewer");
	return (
		<div data-reader-annotations className="font-sans text-sm select-none">
			<TooltipProvider delayDuration={200}>
				{highlights.map((highlight) => {
					const item: PageAnnotationComment = {
						id: highlight.id,
						pageIndex: highlight.page - 1,
						kind: "highlight",
						quote: highlight.quote,
						comment: highlight.comment ?? "",
						color: normalizeHighlightColor(highlight.color),
						rects: highlight.rects,
						anchorY: highlight.rects[0]?.y ?? 0,
						linkAlias: null,
					};
					const editing = editingId === item.id;
					return item.comment || editing ? (
						<CommentCard
							key={item.id}
							flow
							item={item}
							editing={editing}
							wikiTarget={wikiTarget}
							hovered={false}
							topPx={0}
							heightPx={estimateCommentCardHeight(item, editing)}
							onOpen={handlers.onOpenComment}
							onSave={handlers.onSaveComment}
							onCancel={handlers.onCancelComment}
							onDelete={handlers.onDeleteComment}
							onCopyLink={handlers.onCopyCommentLink}
							onCopyEmbed={handlers.onCopyCommentEmbed}
							onAddToChat={handlers.onAddCommentToChat}
							onHover={handlers.onHoverComment}
							onLeave={handlers.onLeaveComment}
						/>
					) : (
						<Button
							key={item.id}
							size="icon-xs"
							variant="ghost"
							data-pdf-chrome
							data-reader-mark={item.id}
							title={item.quote}
							aria-label={t("selection.note")}
							onClick={() => handlers.onOpenComment(item)}
						>
							<Highlighter
								className="size-3.5"
								style={{ color: HIGHLIGHT_HEX[item.color] }}
							/>
						</Button>
					);
				})}
				{draft && (
					<SelectionCommentAffordance
						flow
						draft={draft}
						pageHeightPx={0}
						onCommit={handlers.onCommitSelectionComment}
						onActiveChange={handlers.onSelectionCommentActiveChange}
						onDismiss={handlers.onDismissSelectionComment}
					/>
				)}
			</TooltipProvider>
		</div>
	);
}
