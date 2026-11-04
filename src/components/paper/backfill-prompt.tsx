import { useTranslation } from "react-i18next";
import {
	BackfillReview,
	BackfillSummary,
} from "@/components/paper/backfill-review";
import type { BackfillPreview } from "@/lib/core/bindings";

export function BackfillPrompt({
	preview,
	onStart,
	onLater,
}: {
	preview: BackfillPreview;
	onStart: (paths: string[]) => Promise<void>;
	onLater: () => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<section
			aria-label={t("doctor.backfill.title")}
			className="w-full rounded-xl border border-border/70 bg-popover p-4 text-popover-foreground shadow-lg"
		>
			<h2 className="mb-2.5 font-semibold text-sm tracking-tight">
				{t("doctor.backfill.title")}
			</h2>
			<BackfillSummary preview={preview} />
			<BackfillReview
				preview={preview}
				onStart={onStart}
				onLater={onLater}
				collapsible
			/>
		</section>
	);
}
