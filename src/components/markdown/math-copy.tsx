import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import { installRenderedMathCopy } from "@/lib/markdown/rendered-math-copy";

/** Copy chrome stays outside KaTeX's imperatively rendered / evicted children. */
export function MathCopy({
	children,
	className,
	tex,
	as: Tag = "span",
}: {
	children?: ReactNode;
	className?: string;
	/** Explicit source for the equation editor's copy button. */
	tex?: string;
	as?: "span" | "div";
}) {
	const { t } = useTranslation("editor");
	const hasFormula = Boolean(children);
	useEffect(installRenderedMathCopy, []);
	return (
		<Tag
			data-math-copy
			data-math-copy-tex={tex}
			data-math-copy-success={t("equation.copied")}
			data-math-copy-error={t("equation.copyFailed")}
			data-math-copy-formula={hasFormula ? "" : undefined}
			role={hasFormula ? "button" : undefined}
			tabIndex={hasFormula ? 0 : undefined}
			aria-label={hasFormula ? t("equation.copy") : undefined}
			onKeyDown={
				hasFormula
					? (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								event.currentTarget.click();
							}
						}
					: undefined
			}
			className={cn(
				"group/math-copy inline-flex min-w-0 max-w-full items-baseline gap-0.5 align-baseline",
				hasFormula &&
					"relative rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:ring-1 focus-visible:ring-ring active:bg-primary/15",
				className,
			)}
			contentEditable={false}
		>
			{children}
			{hasFormula ? null : (
				<TooltipProvider delayDuration={300}>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								data-math-copy-button
								data-math-copy-ui
								aria-label={t("equation.copy")}
								className="self-center text-muted-foreground motion-reduce:transition-none motion-reduce:active:not-aria-[haspopup]:translate-y-0 motion-reduce:active:not-aria-[haspopup]:scale-100"
							>
								<CopyIcon
									className="size-3.5 group-data-[math-copied]/math-copy:hidden"
									aria-hidden
								/>
								<CheckIcon
									className="hidden size-3.5 text-primary group-data-[math-copied]/math-copy:block"
									aria-hidden
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent sideOffset={4}>{t("equation.copy")}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			)}
			<span
				data-math-copy-ui
				data-math-copy-status
				role="status"
				aria-live="polite"
				className="sr-only"
			/>
		</Tag>
	);
}
