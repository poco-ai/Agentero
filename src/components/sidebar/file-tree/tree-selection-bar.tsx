/**
 * Floating batch-action pill for the vault tree's explicit selection mode.
 * Mirrors the library table's selection bar (same visual language) without
 * replacing the fixed sidebar header.
 */
import { FolderInput, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { SelectionPill } from "@/components/ui/selection-pill";

export function TreeSelectionBar({
	count,
	compact = false,
	canMove,
	onMove,
	onDelete,
	onDone,
}: {
	count: number;
	/** Narrow sidebar: count as a bare number so the pill fits 160px. */
	compact?: boolean;
	canMove: boolean;
	onMove: (anchor: { x: number; y: number }) => void;
	onDelete: () => void;
	onDone: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const anchorRef = useRef<HTMLDivElement>(null);
	const countLabel = compact
		? String(count)
		: t("fileTree.selectedCount", { count });
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-2">
			<div ref={anchorRef} className="pointer-events-auto">
				<SelectionPill
					countLabel={countLabel}
					ariaLabel={t("fileTree.selectedCount", { count })}
					className="py-1.5"
					buttonSize="icon-xs"
					actions={[
						...(canMove
							? [
									{
										id: "move",
										label: t("fileTree.moveSelected", { count }),
										icon: <FolderInput className="size-3.5" />,
										onSelect: () => {
											const rect = anchorRef.current?.getBoundingClientRect();
											if (!rect) return;
											onMove({ x: rect.left, y: rect.top });
										},
									},
								]
							: []),
						{
							id: "delete",
							label: t("fileTree.deleteSelected", { count }),
							icon: <Trash2 className="size-3.5" />,
							onSelect: onDelete,
							destructive: true,
						},
					]}
					onDismiss={onDone}
					dismissLabel={t("fileTree.clearSelection")}
				/>
			</div>
		</div>
	);
}
