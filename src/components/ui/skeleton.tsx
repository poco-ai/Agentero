import { cn } from "@/lib/core/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			className={cn("library-shimmer rounded-md bg-muted", className)}
			{...props}
		/>
	);
}

/** Page-shaped placeholder for a document that has not painted yet. */
function PageSkeleton({
	label,
	className,
}: {
	label?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6",
				className,
			)}
			role="status"
			aria-busy="true"
		>
			{label ? <p className="sr-only">{label}</p> : null}
			<div
				aria-hidden="true"
				className="flex aspect-[210/297] w-[min(100%,32rem)] max-w-full flex-col gap-3 rounded-sm border bg-background px-8 py-7 shadow-sm"
			>
				<Skeleton className="h-5 w-2/5" />
				<Skeleton className="mt-3 h-3 w-full" />
				<Skeleton className="h-3 w-11/12" />
				<Skeleton className="h-3 w-4/5" />
				<Skeleton className="mt-4 h-3 w-full" />
				<Skeleton className="h-3 w-5/6" />
				<Skeleton className="h-3 w-2/3" />
			</div>
		</div>
	);
}

export { PageSkeleton, Skeleton };
