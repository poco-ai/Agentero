import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
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
	useEffect(installRenderedMathCopy, []);
	return (
		<Tag
			data-math-copy
			data-math-copy-tex={tex}
			data-math-copy-success={t("equation.copied")}
			data-math-copy-error={t("equation.copyFailed")}
			className={cn(
				"group/math-copy inline-flex min-w-0 max-w-full items-baseline gap-0.5 align-baseline [&_.katex]:cursor-copy",
				className,
			)}
			contentEditable={false}
		>
			{children}
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				data-math-copy-button
				data-math-copy-ui
				aria-label={t("equation.copy")}
				title={t("equation.copy")}
				className={cn(
					"self-center text-muted-foreground motion-reduce:transition-none motion-reduce:active:not-aria-[haspopup]:translate-y-0 motion-reduce:active:not-aria-[haspopup]:scale-100",
					children &&
						"opacity-0 group-hover/math-copy:opacity-100 group-focus-within/math-copy:opacity-100 group-data-[math-copied]/math-copy:opacity-100 [@media(hover:none)]:opacity-100",
				)}
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
