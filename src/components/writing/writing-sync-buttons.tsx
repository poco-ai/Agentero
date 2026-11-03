/**
 * Overleaf-style SyncTeX pair on the writing split: source → PDF on top,
 * PDF → source below. Both stay out of the editor toolbar.
 */

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getTexEditorCursor } from "@/lib/tex/editor-navigation";
import { syncTexToPdf, syncWritingPdfToSource } from "@/lib/tex/synctex";
import { isTexPath } from "@/lib/workspace/viewer";

export function WritingSyncButtons({
	activeFile,
	position,
}: {
	activeFile: string | null;
	position: number;
}) {
	const { t } = useTranslation("latexLanguage");

	const syncForward = () => {
		const cursor =
			(activeFile && isTexPath(activeFile)
				? getTexEditorCursor(activeFile)
				: null) ?? getTexEditorCursor();
		if (!cursor) return;
		void syncTexToPdf(cursor.path, cursor.line, cursor.column, {
			scope: "writing",
		});
	};

	return (
		<div
			className="pointer-events-auto absolute top-1/3 z-40 flex -translate-x-1/2 -translate-y-1/2 flex-col rounded-full border border-border bg-popover p-0.5 text-popover-foreground shadow-md"
			style={{ left: `${position}%` }}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						size="icon-xs"
						variant="ghost"
						aria-label={t("syncPdf")}
						className="cursor-pointer rounded-full text-popover-foreground hover:bg-accent hover:text-accent-foreground"
						onClick={syncForward}
					>
						<ArrowRight className="size-3.5" aria-hidden />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="right" sideOffset={8}>
					{t("syncPdfHint")}
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						size="icon-xs"
						variant="ghost"
						aria-label={t("syncSource")}
						className="cursor-pointer rounded-full text-popover-foreground hover:bg-accent hover:text-accent-foreground"
						onClick={() => {
							syncWritingPdfToSource();
						}}
					>
						<ArrowLeft className="size-3.5" aria-hidden />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="right" sideOffset={8}>
					{t("syncSourceHint")}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
