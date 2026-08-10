import type { PdfBookmarkObject } from "@embedpdf/models";
import { List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { OutlineTree } from "@/components/viewer/pdf/chrome/outline-tree";

type PdfOutlinePanelProps = {
	/** Document bookmarks; both the toggle and the panel hide when empty. */
	outline: PdfBookmarkObject[];
	showOutline: boolean;
	onToggleOutline: () => void;
	onGoToPage: (page: number) => void;
};

/** Outline toggle (top-left) plus the collapsible bookmark sidebar. */
export function PdfOutlinePanel({
	outline,
	showOutline,
	onToggleOutline,
	onGoToPage,
}: PdfOutlinePanelProps) {
	const { t } = useTranslation("viewer");

	return (
		<>
			{outline.length > 0 ? (
				<div className="pointer-events-none absolute top-2 left-3 z-30">
					<TooltipProvider delayDuration={200}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									className="pointer-events-auto rounded-lg border border-border/80 bg-background/95 shadow-sm backdrop-blur-sm"
									aria-label={t("pdf.outline")}
									aria-pressed={showOutline}
									onClick={onToggleOutline}
								>
									<List className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.outline")}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			) : null}
			{showOutline && outline.length > 0 ? (
				<aside className="agentero-scroll absolute inset-y-0 left-0 z-20 w-60 border-r bg-background/95 pt-11 pb-2 backdrop-blur-sm">
					<div className="px-2">
						<OutlineTree nodes={outline} depth={0} onGoToPage={onGoToPage} />
					</div>
				</aside>
			) : null}
		</>
	);
}
