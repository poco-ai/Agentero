import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/core/utils";

/** Big onboarding action card (icon + title + optional description), used across wizard steps. */
export function ChoiceCard({
	icon,
	title,
	description,
	recommended,
	recommendedLabel,
	selected,
	onClick,
}: {
	icon: React.ReactNode;
	title: string;
	description?: string;
	recommended?: boolean;
	recommendedLabel?: string;
	/** Mark this card as the current choice (default) rather than a plain action. */
	selected?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected === undefined ? undefined : selected}
			onClick={onClick}
			className={cn(
				"relative flex flex-col items-center justify-center gap-2.5 rounded-xl border bg-background p-5 text-center outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
				selected
					? "border-primary ring-1 ring-primary/30 hover:border-primary"
					: recommended
						? "border-primary/60 hover:border-primary"
						: "hover:border-primary/60",
			)}
		>
			{recommended && recommendedLabel ? (
				<Badge variant="default" className="absolute top-2 right-2">
					{recommendedLabel}
				</Badge>
			) : null}
			<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
				{icon}
			</div>
			<div className="space-y-1">
				<p className="font-medium text-sm">{title}</p>
				{description ? (
					<p className="line-clamp-2 text-muted-foreground text-xs leading-snug">
						{description}
					</p>
				) : null}
			</div>
		</button>
	);
}
