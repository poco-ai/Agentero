import { useTranslation } from "react-i18next";
import type { ScreenPoint } from "@/components/viewer/pdf/types";

const CARD_WIDTH = 300;
const CARD_ESTIMATED_HEIGHT = 116;

export function PdfCitationPreview({
	screen,
	previewText,
	onPointerEnter,
	onPointerLeave,
}: {
	screen: ScreenPoint;
	previewText: string;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
}) {
	const { t } = useTranslation("viewer");
	const viewportWidth =
		typeof window === "undefined" ? 1200 : window.innerWidth;
	const viewportHeight =
		typeof window === "undefined" ? 800 : window.innerHeight;
	const left = Math.min(
		Math.max(12, screen.x),
		viewportWidth - CARD_WIDTH - 12,
	);
	const top = Math.min(
		Math.max(12, screen.y),
		viewportHeight - CARD_ESTIMATED_HEIGHT - 12,
	);

	return (
		<div
			role="dialog"
			aria-label={t("references.previewLabel", { marker: "" })}
			className="fixed z-50 w-[300px] rounded-xl border border-border/80 bg-background/98 p-3 shadow-xl ring-1 ring-black/5 backdrop-blur-sm dark:ring-white/10"
			style={{ left, top }}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
		>
			<p className="line-clamp-4 text-[13px] leading-snug text-foreground">
				{previewText}
			</p>
		</div>
	);
}
