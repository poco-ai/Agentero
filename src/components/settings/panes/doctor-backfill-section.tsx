import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	BackfillReview,
	BackfillSummary,
} from "@/components/paper/backfill-review";
import { Button } from "@/components/ui/button";
import type { BackfillPreview } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { checkPaperBackfill, enqueuePaperBackfill } from "@/lib/paper/backfill";
import { DoctorSection } from "./doctor-sections";

export function DoctorBackfillSection({ vaultPath }: { vaultPath: string }) {
	const { t } = useTranslation("settings");
	const [preview, setPreview] = useState<BackfillPreview | null>(null);
	const [loading, setLoading] = useState(true);
	const [review, setReview] = useState(0);
	useEffect(() => {
		let current = true;
		setPreview(null);
		setLoading(true);
		void checkPaperBackfill(vaultPath)
			.then((result) => {
				if (current) setPreview(result);
			})
			.catch((error: unknown) => {
				if (current) notifyError(errorText(error));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [vaultPath]);
	const check = useCallback(async () => {
		setLoading(true);
		try {
			const result = await checkPaperBackfill(vaultPath);
			setPreview(result);
			setReview((current) => current + 1);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setLoading(false);
		}
	}, [vaultPath]);
	const pending = (preview?.downloadSource ?? 0) + (preview?.parseBody ?? 0);
	return (
		<DoctorSection
			framed={false}
			title={t("doctor.backfill.title")}
			description={t("doctor.backfill.hint")}
			ok={pending === 0}
			issueCount={pending}
			action={
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={loading}
					onClick={() => void check()}
				>
					{loading && <Loader2 className="animate-spin" />}
					{t("doctor.backfill.check")}
				</Button>
			}
		>
			<div className="px-0.5 py-1">
				{preview ? (
					<BackfillSummary preview={preview} />
				) : loading ? (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				) : null}
				{review > 0 && preview && pending > 0 && (
					<BackfillReview
						key={review}
						preview={preview}
						onStart={async (paths) => {
							setLoading(true);
							try {
								await enqueuePaperBackfill(vaultPath, paths);
								setReview(0);
								setPreview(await checkPaperBackfill(vaultPath));
							} finally {
								setLoading(false);
							}
						}}
					/>
				)}
			</div>
		</DoctorSection>
	);
}
