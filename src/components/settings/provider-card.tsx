import type { ComponentProps, ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/core/utils";
import { type ProbeStatus, probeDotClass } from "@/lib/ui/probe-status";

type ProbeDotProps = {
	status: ProbeStatus;
	configured?: boolean;
	label: string;
	title?: string;
} & Omit<ComponentProps<"span">, "role" | "aria-label" | "title">;

/**
 * Provider probe status dot. Remaining span props are forwarded: Radix
 * `TooltipTrigger asChild` clones its child with trigger handlers/ref, which
 * must land on the span.
 */
export function ProbeDot({
	status,
	configured,
	label,
	title,
	className,
	...props
}: ProbeDotProps) {
	return (
		<span
			{...props}
			role="status"
			aria-label={label}
			title={title}
			className={cn(
				"inline-block size-1.5 shrink-0 rounded-full",
				probeDotClass(status, configured),
				className,
			)}
		/>
	);
}

export function ProviderCard({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-lg border bg-card px-3 py-2.5">{children}</div>
	);
}

export function ProviderCardHeader({
	left,
	right,
}: {
	left: ReactNode;
	right?: ReactNode;
}) {
	return (
		<div className="mb-2 flex items-center justify-between gap-2">
			<div className="flex min-w-0 items-center gap-1.5">{left}</div>
			{right}
		</div>
	);
}

export function ProviderFieldRow({
	label,
	htmlFor,
	children,
}: {
	label: ReactNode;
	htmlFor: string;
	children: ReactNode;
}) {
	return (
		<div data-settings-row="" className="flex items-center gap-2">
			<Label
				data-settings-label=""
				htmlFor={htmlFor}
				className="w-20 shrink-0 font-normal text-muted-foreground text-xs"
			>
				{label}
			</Label>
			{children}
		</div>
	);
}

export const PROVIDER_INPUT_CLASS =
	"h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50";
