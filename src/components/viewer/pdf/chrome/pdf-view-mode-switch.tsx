import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import type { PdfViewMode } from "@/lib/pdf/view-mode";

const MODES: readonly PdfViewMode[] = ["original", "translated", "dual"];

const HINT_KEYS = {
	original: "pdf.viewMode.originalHint",
	translated: "pdf.viewMode.translatedHint",
	dual: "pdf.viewMode.dualHint",
} as const;

type PdfViewModeSwitchProps = {
	mode: PdfViewMode;
	onSelect: (mode: PdfViewMode) => void;
	disabled?: boolean;
	/** No workspace host here (e.g. an inline embed): 对照 cannot open a pane. */
	dualDisabled?: boolean;
};

/**
 * Three-up reading-view control in the PDF toolbar. 原文 / 译文 / 对照 map to
 * one merged label group so the current view is always visible; it replaces
 * the old translate button in the right-hand chip.
 */
export const PdfViewModeSwitch = memo(function PdfViewModeSwitch({
	mode,
	onSelect,
	disabled = false,
	dualDisabled = false,
}: PdfViewModeSwitchProps) {
	const { t } = useTranslation("viewer");

	const handleKeyDown = (event: React.KeyboardEvent<HTMLFieldSetElement>) => {
		if (disabled) return;
		const step =
			event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		let index = MODES.indexOf(mode);
		let next = mode;
		for (let visited = 0; visited < MODES.length; visited++) {
			index = (index + step + MODES.length) % MODES.length;
			const candidate = MODES[index];
			if (candidate === "dual" && dualDisabled) continue;
			next = candidate;
			break;
		}
		if (next === mode) return;
		onSelect(next);
		const group = event.currentTarget;
		queueMicrotask(() => {
			group
				.querySelector<HTMLButtonElement>(`[data-view-mode="${next}"]`)
				?.focus();
		});
	};

	return (
		<fieldset
			onKeyDown={handleKeyDown}
			className={cn(
				"m-0 flex h-6 min-w-0 items-center rounded-md border-0 bg-muted p-0.5",
				disabled && "opacity-50",
			)}
		>
			<legend className="sr-only">{t("pdf.viewMode.label")}</legend>
			{MODES.map((value) => {
				const selected = value === mode;
				return (
					<button
						key={value}
						type="button"
						aria-pressed={selected}
						title={t(HINT_KEYS[value])}
						data-view-mode={value}
						disabled={disabled || (value === "dual" && dualDisabled)}
						onClick={() => onSelect(value)}
						className={cn(
							"h-5 rounded-[5px] px-1.5 text-caption leading-none font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
							selected
								? "bg-background text-foreground shadow-raised"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{t(`pdf.viewMode.${value}`)}
					</button>
				);
			})}
		</fieldset>
	);
});
