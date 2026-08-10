import katex from "katex";
import { FileText, FunctionSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";
import type { EquationSymbol } from "@/lib/pdf/equation-annotation";
import { symbolTexSource } from "@/lib/pdf/equation-annotation";

/** Wider so meaning + plain columns wrap without clipping. */
const CARD_WIDTH = 440;
/** Preferred max height; body scrolls when the symbol table is taller. */
const CARD_MAX_HEIGHT = 420;

function FormulaSymbolCell({ symbol }: { symbol: string }) {
	const ref = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const tex = symbolTexSource(symbol);
		if (!tex) {
			el.textContent = symbol;
			return;
		}
		try {
			katex.render(tex, el, {
				throwOnError: false,
				displayMode: false,
				output: "html",
				strict: "ignore",
			});
		} catch {
			el.textContent = symbol;
		}
	}, [symbol]);

	return (
		<span
			ref={ref}
			// No overflow scroll — narrow symbols must not show a horizontal bar.
			className="inline-block font-mono text-[12px] text-foreground/90 leading-none [&_.katex]:text-[13px]"
		/>
	);
}

export function FormulaAnnotationCard({
	screen,
	symbols,
	onOpenFile,
	onClose,
	onPointerEnter,
	onPointerLeave,
}: {
	screen: ScreenPoint;
	symbols: readonly EquationSymbol[];
	onOpenFile?: () => void;
	onClose: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
}) {
	const { t } = useTranslation("viewer");

	const actions = [
		...(onOpenFile
			? [
					{
						label: t("equationAnnotation.openFile"),
						onClick: onOpenFile,
						icon: <FileText className="size-3.5" />,
					},
				]
			: []),
		{
			label: t("equationAnnotation.close"),
			onClick: onClose,
			icon: <X className="size-3.5" />,
		},
	];

	return (
		<SelectionCard
			screen={screen}
			width={CARD_WIDTH}
			height={CARD_MAX_HEIGHT}
			preferRight
			// Stick near the formula; body scrolls when the table exceeds maxHeight.
			trackPin
			bodyScroll
			placementWidth={CARD_WIDTH}
			placementHeight={CARD_MAX_HEIGHT}
			title={t("equationAnnotation.title")}
			icon={FunctionSquare}
			ariaLabel={t("equationAnnotation.aria")}
			bodyClassName="p-0"
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			actions={actions}
		>
			{symbols.length === 0 ? (
				<p className="px-3 py-3 text-[12px] text-muted-foreground">
					{t("equationAnnotation.empty")}
				</p>
			) : (
				<table className="w-full table-fixed border-collapse text-left text-[12px]">
					<thead className="sticky top-0 z-[1] bg-background/95 backdrop-blur-sm">
						<tr className="border-border/60 border-b text-[11px] text-muted-foreground">
							<th className="w-[18%] px-3 py-1.5 font-medium">
								{t("equationAnnotation.colSymbol")}
							</th>
							<th className="w-[46%] px-2 py-1.5 font-medium">
								{t("equationAnnotation.colMeaning")}
							</th>
							<th className="w-[36%] px-3 py-1.5 font-medium">
								{t("equationAnnotation.colPlain")}
							</th>
						</tr>
					</thead>
					<tbody>
						{symbols.map((row) => (
							<tr
								key={symbolTexSource(row.symbol) || row.symbol}
								className={cn(
									"border-border/40 border-b last:border-b-0",
									"align-top",
								)}
							>
								<td className="px-3 py-1.5 whitespace-nowrap">
									<FormulaSymbolCell symbol={row.symbol} />
								</td>
								<td className="break-words px-2 py-1.5 text-foreground/90 leading-snug">
									{row.meaning || t("equationAnnotation.emptyMeaning")}
								</td>
								<td className="break-words px-3 py-1.5 text-muted-foreground leading-snug">
									{row.plain || ""}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</SelectionCard>
	);
}
