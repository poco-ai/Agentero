/**
 * Floating batch-action pill for the library table. Appears only while rows
 * are selected; overlays the bottom of the view (no layout shift, so a
 * marquee drag never moves rows under the pointer).
 */
import { MessageSquarePlus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

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
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center px-3">
			<div
				role="toolbar"
				aria-label={t("papersLibrary.selection.count", { count })}
				className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border/60 bg-popover/95 py-1 pr-1 pl-3 shadow-raised backdrop-blur"
			>
				<span
					aria-live="polite"
					className="mr-1 text-muted-foreground text-xs tabular-nums"
				>
					{t("papersLibrary.selection.count", { count })}
				</span>
				<span aria-hidden className="mr-0.5 h-4 w-px bg-border/60" />
				<BarButton
					label={t("fileTree.addToChat")}
					onClick={onAddToChat}
					icon={<MessageSquarePlus className="size-3.5" />}
				/>
				<BarButton
					label={t("papersLibrary.selection.delete", { count })}
					onClick={onDelete}
					destructive
					icon={<Trash2 className="size-3.5" />}
				/>
				<BarButton
					label={t("papersLibrary.selection.clear")}
					onClick={onClear}
					icon={<X className="size-3.5" />}
				/>
			</div>
		</div>
	);
}

function BarButton({
	label,
	onClick,
	icon,
	destructive = false,
}: {
	label: string;
	onClick: () => void;
	icon: ReactNode;
	destructive?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={label}
					className={
						destructive ? "text-destructive hover:text-destructive" : ""
					}
					onClick={onClick}
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}
