import { cn } from "@/lib/core/utils";

export type StatusDotTone = "ok" | "idle" | "warn" | "err";

export function StatusDot({
	tone,
	label,
}: {
	tone: StatusDotTone;
	label: string;
}) {
	return (
		<span className="inline-flex items-center gap-2 text-muted-foreground text-xs">
			<span
				role="img"
				aria-label={label}
				className={cn(
					"size-2 rounded-full",
					tone === "ok" && "bg-emerald-500",
					tone === "idle" && "bg-muted-foreground/50",
					tone === "warn" && "bg-amber-500",
					tone === "err" && "bg-destructive",
				)}
			/>
			{label}
		</span>
	);
}
