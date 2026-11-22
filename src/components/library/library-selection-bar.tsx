/**
 * Floating batch-action pill for the library table. Appears only while rows
 * are selected; overlays the bottom of the view (no layout shift, so a
 * marquee drag never moves rows under the pointer).
 */
import { MessageSquarePlus, Trash2, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SelectionPill } from "@/components/ui/selection-pill";

export function LibrarySelectionBar({
	count,
	onAddToChat,
	onDelete,
	onClear,
}: {
	count: number;
	onAddToChat: () => void;
	onDelete: () => void;
	onClear: () => void;
}) {
	const { t } = useTranslation("sidebar");
	if (count === 0) return null;
	const countLabel = t("papersLibrary.selection.count", { count });
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-3">
			<SelectionPill
				countLabel={countLabel}
				ariaLabel={countLabel}
				actions={[
					{
						id: "add-to-chat",
						label: t("fileTree.addToChat"),
						icon: <MessageSquarePlus className="size-3.5" />,
						onSelect: onAddToChat,
					},
					{
						id: "delete",
						label: t("papersLibrary.selection.delete", { count }),
						icon: <Trash2 className="size-3.5" />,
						onSelect: onDelete,
						destructive: true,
					},
				]}
				onDismiss={onClear}
				dismissLabel={t("papersLibrary.selection.clear")}
				dismissIcon={<XIcon className="size-3.5" />}
			/>
		</div>
	);
}
