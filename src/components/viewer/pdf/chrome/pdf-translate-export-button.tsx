import { Download } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type PdfTranslateExportButtonProps = {
	/** Mount the control only when the generated pages are ready to export. */
	onExport: (dual?: boolean) => void;
};

/**
 * Export control for the generated translated PDF. The reader toolbar owns it
 * in 译文; in 对照 the translation pane owns it, so both modes hand the same
 * output to the same menu instead of growing a second export surface.
 */
export const PdfTranslateExportButton = memo(function PdfTranslateExportButton({
	onExport,
}: PdfTranslateExportButtonProps) {
	const { t } = useTranslation("viewer");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label={t("pdf.layoutTranslate.exportPdf")}
				>
					<Download className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuItem onSelect={() => onExport(false)}>
					{t("pdf.layoutTranslate.exportPdf")}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onExport(true)}>
					{t("pdf.layoutTranslate.exportDualPdf")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
});
