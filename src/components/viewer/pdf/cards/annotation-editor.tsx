import { NotebookPen, Trash2Icon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { useImeGuard } from "@/hooks/use-ime-guard";

type AnnotationEditorProps = {
	/** Screen point near the highlight (from popoverScreenPoint) */
	screen: ScreenPoint;
	/** Existing note text when editing; empty for a fresh annotation */
	initialComment?: string;
	/** Save the (possibly empty) note; empty means "no comment / plain highlight" */
	onSave: (text: string) => void;
	/** Cancel edit: close without saving and without deleting the highlight */
	onClose: () => void;
	/** Delete the underlying highlight and close. */
	onDelete: () => void;
	/** Same hover-hide contract as ask / translate cards */
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
};

/**
 * Floating note editor — quote (context) + note field + cancel/save.
 * Header: delete (hover red) + close, aligned with visual annotation cards.
 */
export function AnnotationEditor({
	screen,
	initialComment,
	onSave,
	onClose,
	onDelete,
	onPointerEnter,
	onPointerLeave,
}: AnnotationEditorProps) {
	const { t } = useTranslation("viewer");
	const [text, setText] = useState(initialComment ?? "");
	const ref = useRef<HTMLTextAreaElement>(null);
	const { isBlockedByIme, compositionProps } = useImeGuard();

	useEffect(() => {
		ref.current?.focus();
	}, []);

	// Re-sync when switching to another annotation without unmounting.
	useEffect(() => {
		setText(initialComment ?? "");
	}, [initialComment]);

	const actions = useMemo(
		() => [
			{
				label: t("annotations.delete"),
				onClick: onDelete,
				icon: <Trash2Icon className="size-3.5" />,
				destructive: true,
			},
			{
				label: t("annotations.close"),
				onClick: onClose,
				icon: <X className="size-3.5" />,
			},
		],
		[t, onDelete, onClose],
	);

	return (
		<SelectionCard
			screen={screen}
			width={240}
			height={200}
			preferRight
			title={t("annotations.editorLabel")}
			icon={NotebookPen}
			ariaLabel={t("annotations.editorLabel")}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			bodyClassName="gap-2 px-3 py-2.5"
			actions={actions}
			footer={
				<div className="flex items-center justify-end gap-1">
					<Button type="button" variant="ghost" size="sm" onClick={onClose}>
						{t("annotations.cancel")}
					</Button>
					<Button type="button" size="sm" onClick={() => onSave(text)}>
						{t("annotations.save")}
					</Button>
				</div>
			}
		>
			<textarea
				ref={ref}
				className="min-h-16 w-full min-w-0 flex-1 resize-none rounded-md border border-border/80 bg-transparent p-2 text-sm text-foreground/80 outline-none placeholder:text-muted-foreground/80 focus:ring-1 focus:ring-ring"
				placeholder={t("annotations.placeholder")}
				value={text}
				onChange={(e) => setText(e.target.value)}
				// Focus/click re-arms pin hover surface (parent hide timer).
				onFocus={onPointerEnter}
				onPointerDown={onPointerEnter}
				{...compositionProps}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						onClose();
						return;
					}
					// Enter = save; Shift+Enter = newline (same as ask composer).
					// Skip while IME is composing / confirming a candidate.
					if (e.key === "Enter" && !e.shiftKey && !isBlockedByIme(e)) {
						e.preventDefault();
						onSave(text);
					}
				}}
			/>
		</SelectionCard>
	);
}
