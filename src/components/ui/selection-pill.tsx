import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

export type SelectionPillAction = {
	/** Stable identity for the action list. */
	id: string;
	/** Accessible name and tooltip text. */
	label: string;
	icon: ReactNode;
	onSelect: () => void;
	destructive?: boolean;
	disabled?: boolean;
};

/**
 * Floating capsule that summarizes a multi-selection and exposes batch
 * actions. Purely presentational: every label is passed in by the caller and
 * the caller owns the positioning container. The count is mirrored into the
 * toolbar's accessible name so the pill can be announced as a group.
 */
export function SelectionPill({
	countLabel,
	ariaLabel,
	actions,
	onDismiss,
	dismissLabel,
	dismissIcon,
	className,
	buttonSize = "icon-sm",
}: {
	countLabel: string;
	ariaLabel?: string;
	actions: SelectionPillAction[];
	onDismiss: () => void;
	dismissLabel: string;
	dismissIcon?: ReactNode;
	className?: string;
	/** Compact callers (narrow tree sidebar) can shrink the action buttons. */
	buttonSize?: "icon-sm" | "icon-xs";
}) {
	return (
		<div
			role="toolbar"
			aria-label={ariaLabel ?? countLabel}
			data-slot="selection-pill"
			className={cn(
				"pointer-events-auto flex items-center gap-0.5 rounded-full border border-border/60 bg-popover/95 py-1 pr-1 pl-3 shadow-raised backdrop-blur",
				className,
			)}
		>
			<span
				aria-live="polite"
				className="mr-1 text-muted-foreground text-xs tabular-nums"
			>
				{countLabel}
			</span>
			<span aria-hidden className="mr-0.5 h-4 w-px bg-border/60" />
			{actions.map((action) => (
				<PillAction
					key={action.id}
					label={action.label}
					icon={action.icon}
					onSelect={action.onSelect}
					destructive={action.destructive}
					disabled={action.disabled}
					buttonSize={buttonSize}
				/>
			))}
			<PillAction
				label={dismissLabel}
				icon={dismissIcon ?? <XIcon className="size-3.5" />}
				onSelect={onDismiss}
				buttonSize={buttonSize}
			/>
		</div>
	);
}

function PillAction({
	label,
	icon,
	onSelect,
	destructive = false,
	disabled = false,
	buttonSize,
}: Omit<SelectionPillAction, "id"> & {
	buttonSize: "icon-sm" | "icon-xs";
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size={buttonSize}
					aria-label={label}
					disabled={disabled}
					className={
						destructive ? "text-destructive hover:text-destructive" : undefined
					}
					onClick={onSelect}
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}
