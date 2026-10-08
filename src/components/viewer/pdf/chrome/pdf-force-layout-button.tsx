import { Loader2, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	forcePaperLayoutAnalysis,
	LayoutReanalyzeError,
} from "@/lib/pdf/layout";

type PdfForceLayoutButtonProps = {
	paperAbsPath?: string | null;
	paperRelPath?: string | null;
	/** Remote arXiv papers have no local sidecar to replace. */
	isRemotePaper?: boolean;
	className?: string;
};

/**
 * Confirmed force re-parse for the open paper. Sits in the figures-panel
 * chrome, to the left of the layout overlay toggle.
 */
export function PdfForceLayoutButton({
	paperAbsPath = null,
	paperRelPath = null,
	isRemotePaper = false,
	className,
}: PdfForceLayoutButtonProps) {
	const { t } = useTranslation(["viewer", "common"]);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);

	if (!paperAbsPath || isRemotePaper) return null;

	const confirm = () => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		void forcePaperLayoutAnalysis({ paperAbsPath, paperRelPath })
			.then(() => {
				setOpen(false);
			})
			.catch((error: unknown) => {
				if (error instanceof LayoutReanalyzeError) {
					notifyError(
						error.code === "missing-pdf"
							? t("figures.forceReanalyzeMissingPdf")
							: t("figures.forceReanalyzeFailed"),
					);
					if (error.code === "missing-pdf") setOpen(false);
					return;
				}
				notifyError(t("figures.forceReanalyzeFailed"), {
					description: errorText(error),
				});
			})
			.finally(() => {
				busyRef.current = false;
				setBusy(false);
			});
	};

	return (
		<>
			<div data-pdf-chrome className={className}>
				<TooltipProvider delayDuration={200}>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-6 text-muted-foreground hover:text-foreground"
								aria-label={t("figures.forceReanalyze")}
								disabled={busy}
								onClick={() => setOpen(true)}
							>
								{busy ? (
									<Loader2 className="size-3.5 animate-spin" aria-hidden />
								) : (
									<RefreshCw className="size-3.5" aria-hidden />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("figures.forceReanalyze")}
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!busy) setOpen(next);
				}}
			>
				<DialogContent showCloseButton={false} className="sm:max-w-xs">
					<DialogHeader>
						<DialogTitle>{t("figures.forceReanalyzeTitle")}</DialogTitle>
						<DialogDescription>
							{t("figures.forceReanalyzeBody")}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setOpen(false)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							type="button"
							variant="default"
							size="sm"
							disabled={busy}
							onClick={confirm}
						>
							{busy ? (
								<Loader2 className="size-3.5 animate-spin" aria-hidden />
							) : null}
							{t("figures.forceReanalyzeConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
