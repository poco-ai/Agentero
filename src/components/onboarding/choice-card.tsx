import { Check } from "lucide-react";
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
	className,
	...props
}: {
	icon: React.ReactNode;
	title: string;
	description?: string;
	recommended?: boolean;
	recommendedLabel?: string;
	selected?: boolean;
} & React.ComponentProps<"button">) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			{...props}
			className={cn(
				"relative flex flex-col items-center justify-center gap-2.5 rounded-xl border bg-background p-5 text-center outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
				selected
					? "border-primary bg-primary/5 hover:border-primary"
					: selected === undefined && recommended
						? "border-primary/60 hover:border-primary"
						: "hover:border-primary/60",
				className,
			)}
		>
			{selected ? (
				<Check
					aria-hidden
					className="absolute top-2 left-2 size-4 text-primary"
				/>
			) : null}
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
					<p
						className={cn(
							"text-muted-foreground text-xs leading-snug",
							selected === undefined && "line-clamp-2",
						)}
					>
						{description}
					</p>
				) : null}
			</div>
		</button>
	);
}
