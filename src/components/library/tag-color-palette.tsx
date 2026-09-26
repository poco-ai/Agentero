import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import {
	TAG_COLOR_IDS,
	type TagColorId,
	tagSwatchStyle,
} from "@/lib/ui/tag-colors";

/** Shared by the new-tag input and existing tag editors. */
export function TagColorPalette({
	color,
	disabled,
	onChange,
}: {
	color?: TagColorId | null;
	disabled?: boolean;
	onChange: (color: TagColorId | null) => void;
}) {
	const { t } = useTranslation("sidebar");
	return (
		<div className="flex items-center gap-1">
			{[null, ...TAG_COLOR_IDS].map((id) => {
				const label = id
					? t(`paperInfo.tagColors.${id}`)
					: t("paperInfo.tagColorDefault");
				return (
					<button
						key={id ?? "default"}
						type="button"
						data-tag-color-picker
						disabled={disabled}
						aria-label={label}
						title={label}
						aria-pressed={(color ?? null) === id}
						className={cn(
							"relative size-5 overflow-hidden rounded-full bg-background ring-1 ring-border hover:ring-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
							(color ?? null) === id && "ring-2 ring-foreground/50",
						)}
						style={tagSwatchStyle(id)}
						onClick={() => onChange(id)}
					>
						{id == null && (
							<span
								className="pointer-events-none absolute top-1/2 -left-1/4 h-px w-[150%] -translate-y-1/2 rotate-45 bg-red-500"
								aria-hidden
							/>
						)}
					</button>
				);
			})}
		</div>
	);
}
