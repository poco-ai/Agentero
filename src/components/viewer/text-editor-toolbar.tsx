import { ChevronDown, Quote, Shapes } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import {
	FONT_SIZES,
	type TextEditorFontSize,
} from "@/components/viewer/text-editor-font-size";
import { cn } from "@/lib/core/utils";

interface TextEditorToolbarProps {
	fontSize: TextEditorFontSize;
	onFontSizeChange: (size: TextEditorFontSize) => void;
	/** TeX-only actions; null hides the citation entry. */
	texTools?: {
		onCitation: () => void;
		onFigure: () => void;
	} | null;
}

export function TextEditorToolbar({
	fontSize,
	onFontSizeChange,
	texTools,
}: TextEditorToolbarProps) {
	const { t } = useTranslation("settings");
	const { t: tx } = useTranslation("latexLanguage");
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const handleSelect = useCallback(
		(size: TextEditorFontSize) => {
			onFontSizeChange(size);
			setOpen(false);
		},
		[onFontSizeChange],
	);

	return (
		<div className="absolute top-2 right-3 z-20 flex items-center gap-1">
			<div
				data-text-editor-chrome
				className={cn(
					"pointer-events-auto flex h-7 select-none items-center gap-0.5 rounded-lg p-0.5",
					PDF_CHROME_CHIP,
				)}
			>
				{texTools ? (
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="shrink-0 self-center whitespace-nowrap"
						onClick={texTools.onCitation}
					>
						<Quote className="size-3.5" aria-hidden />
						{tx("insertCitation")}
					</Button>
				) : null}
				{texTools ? (
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="shrink-0 self-center whitespace-nowrap"
						aria-label={tx("editFigure")}
						onClick={texTools.onFigure}
					>
						<Shapes className="size-3.5" aria-hidden />
					</Button>
				) : null}

				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							className="flex h-5 gap-1 self-center whitespace-nowrap px-1.5 text-xs"
							ref={triggerRef}
							aria-label={t("appearance.fontSize.select")}
						>
							<span>{fontSize}px</span>
							<ChevronDown className="size-3" aria-hidden />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						side="bottom"
						align="end"
						className="w-auto p-1.5"
						onOpenAutoFocus={(e) => e.preventDefault()}
					>
						<div className="flex flex-col gap-0.5">
							{FONT_SIZES.map((size) => (
								<button
									key={size}
									type="button"
									onClick={() => handleSelect(size)}
									className={cn(
										"flex h-7 w-full items-center justify-center rounded-md px-3 text-xs",
										"hover:bg-accent hover:text-accent-foreground",
										"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
										"transition-colors duration-[var(--motion-duration-micro)]",
										size === fontSize
											? "bg-accent font-medium text-accent-foreground"
											: "text-muted-foreground",
									)}
								>
									{size}px
								</button>
							))}
						</div>
					</PopoverContent>
				</Popover>
			</div>
		</div>
	);
}
