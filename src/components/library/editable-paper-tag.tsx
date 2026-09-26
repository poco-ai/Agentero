import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { PaperTagChip } from "@/components/library/paper-tag-chip";
import { TagColorPalette } from "@/components/library/tag-color-palette";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { errorMessage, notifyError } from "@/lib/core/notify";
import type { PaperTag } from "@/lib/paper/tags";
import type { TagColorId } from "@/lib/ui/tag-colors";

export function EditablePaperTag({
	tag,
	disabled,
	onColorChange,
	trailing,
}: {
	tag: PaperTag;
	disabled?: boolean;
	onColorChange: (color: TagColorId | null) => Promise<void> | void;
	trailing?: ReactNode;
}) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const save = async (color: TagColorId | null) => {
		if (busy || disabled) return;
		setBusy(true);
		try {
			await onColorChange(color);
			setOpen(false);
		} catch (error) {
			notifyError(t("paperInfo.tagsSaveFailed"), {
				description: errorMessage(error),
			});
		} finally {
			setBusy(false);
		}
	};
	return (
		<span className="inline-flex items-center gap-0.5">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						disabled={disabled || busy}
						className="rounded cursor-pointer hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
						aria-label={t("paperInfo.editTagColor", { tag: tag.name })}
						title={t("paperInfo.tagColor")}
						onClick={(event) => event.stopPropagation()}
						onDoubleClick={(event) => event.stopPropagation()}
					>
						<PaperTagChip tag={tag} />
					</button>
				</PopoverTrigger>
				<PopoverContent
					className="w-auto p-2"
					align="start"
					aria-label={t("paperInfo.tagColor")}
					onClick={(event) => event.stopPropagation()}
					onDoubleClick={(event) => event.stopPropagation()}
				>
					<TagColorPalette
						color={tag.color}
						disabled={disabled || busy}
						onChange={(color) => void save(color)}
					/>
				</PopoverContent>
			</Popover>
			{trailing}
		</span>
	);
}
