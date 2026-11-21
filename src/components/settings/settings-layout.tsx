import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

/** Shared inset card chrome — System Settings–style grouped list. */
export const settingsCardClassName =
	"overflow-hidden rounded-xl border border-border/70 bg-card shadow-[0_1px_0_oklch(0_0_0/0.03)] dark:border-border/60 dark:shadow-[0_1px_0_oklch(1_0_0/0.04)]";

/** Row padding used by SettingsRow and sibling custom rows. */
export const settingsRowClassName =
	"flex items-center justify-between gap-4 border-b border-border/50 px-3.5 py-2.5 last:border-b-0 min-h-10";

/** Label with a small "?" control; the hint lives in a tooltip, not a row. */
export function HelpLabel({ label, help }: { label: ReactNode; help: string }) {
	return (
		<span className="inline-flex items-center gap-1">
			{label}
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className={cn(
							"inline-flex size-5 shrink-0 items-center justify-center rounded-full",
							"text-muted-foreground outline-none transition-[color,background-color,transform]",
							"duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)]",
							"hover:bg-muted hover:text-foreground",
							"focus-visible:ring-1 focus-visible:ring-ring",
							"active:scale-95",
						)}
						aria-label={help}
					>
						<CircleHelp className="size-3.5" aria-hidden />
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-64">{help}</TooltipContent>
			</Tooltip>
		</span>
	);
}

export function PageTitle({
	title,
	actions,
	className,
}: {
	title: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	if (!actions) {
		return (
			<h2
				className={cn(
					"mb-4 font-semibold text-base text-foreground",
					className,
				)}
			>
				{title}
			</h2>
		);
	}
	return (
		<div
			className={cn("mb-4 flex items-center justify-between gap-3", className)}
		>
			<h2 className="min-w-0 font-semibold text-base text-foreground">
				{title}
			</h2>
			<div className="flex shrink-0 items-center gap-2">{actions}</div>
		</div>
	);
}

/** Small section label above a SettingsGroup (Fonts, Sync scope, …). */
export function SettingsSectionLabel({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p
			className={cn(
				// text-xs (not text-caption): twMerge treats unknown text-* as one
				// group and would drop a custom size when paired with text-muted-*.
				"mb-1.5 px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide",
				className,
			)}
		>
			{children}
		</p>
	);
}

export function SettingsGroup({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("mb-5", className)}>
			<div className={settingsCardClassName}>{children}</div>
		</div>
	);
}

export function SettingsRow({
	label,
	htmlFor,
	description,
	children,
	className,
}: {
	label: ReactNode;
	htmlFor?: string;
	/** Optional muted secondary line under the label. */
	description?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn(settingsRowClassName, className)}>
			<div className="min-w-0">
				<Label
					htmlFor={htmlFor}
					className="font-normal text-sm leading-snug text-foreground"
				>
					{label}
				</Label>
				{description ? (
					<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
						{description}
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">{children}</div>
		</div>
	);
}
