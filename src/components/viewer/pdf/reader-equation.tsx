import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

import { copyTextToClipboard } from "@/lib/core/clipboard";
import { getKatexHtml } from "@/lib/math/katex-cache";

import "./reader-equation.css";

/** Only use explicit parser-supplied TeX; PDF glyph strings are not TeX. */
function readerEquationTex(source: string): string | null {
	const text = source.trim();
	if (text.startsWith("$$") && text.endsWith("$$"))
		return text.slice(2, -2).trim() || null;
	if (text.startsWith("\\[") && text.endsWith("\\]"))
		return text.slice(2, -2).trim() || null;
	return null;
}

/** Reuses the app's synchronous KaTeX renderer and bundled fonts. */
export function ReaderEquation({
	source,
	fallback,
}: {
	source: string;
	fallback?: ReactNode;
}) {
	const { t } = useTranslation("viewer");
	const [copied, setCopied] = useState(false);
	const tex = readerEquationTex(source);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1200);
		return () => clearTimeout(timer);
	}, [copied]);
	const html = useMemo(() => {
		if (!tex) return null;
		try {
			return getKatexHtml(tex, {
				displayMode: true,
				output: "htmlAndMathml",
				throwOnError: true,
				strict: "ignore",
				trust: false,
			});
		} catch {
			return null;
		}
	}, [tex]);
	// React replaces innerHTML when its wrapper object changes, even if the
	// string is identical. Keep the selected glyph nodes through menu renders.
	const markup = useMemo(() => (html ? { __html: html } : null), [html]);
	return html ? (
		<span className="reader-equation group/equation flex max-w-full items-start gap-1">
			<span
				data-reader-start={0}
				data-reader-end={source.length}
				data-reader-raster
				className="block min-w-0 flex-1 overflow-x-auto overflow-y-hidden select-text [&_.katex-display]:my-2 [&_.katex-mathml]:select-none"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: Local KaTeX with trust:false; never parser HTML.
				dangerouslySetInnerHTML={markup ?? undefined}
			/>
			<Button
				type="button"
				size="icon-xs"
				variant="ghost"
				data-reader-math-copy
				data-pdf-chrome
				aria-label={t("pdf.reading.copyFormula")}
				title={t("pdf.reading.copyFormula")}
				className="text-inherit opacity-0 hover:bg-current/10 hover:text-inherit active:bg-current/15 active:text-inherit group-hover/equation:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
				onClick={async (event) => {
					event.stopPropagation();
					if (tex)
						setCopied(
							await copyTextToClipboard(tex, {
								errorMessage: t("selection.copyFailed"),
							}),
						);
				}}
			>
				{copied ? (
					<Check className="size-3.5" aria-hidden />
				) : (
					<Copy className="size-3.5" aria-hidden />
				)}
			</Button>
			<span role="status" aria-live="polite" className="sr-only">
				{copied ? t("selection.copied") : ""}
			</span>
		</span>
	) : (
		fallback
	);
}
