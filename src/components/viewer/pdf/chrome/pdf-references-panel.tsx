import { memo } from "react";
import { ReferencesPanel } from "@/components/viewer/panels/references-panel";
import { PDF_SIDE_PANEL } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { cn } from "@/lib/core/utils";

type PdfReferencesPanelProps = {
	vaultPath: string | null;
	paperPath: string | null;
};

/** Left-side citation rail. Mounting is owned by the viewer's panel slot. */
export const PdfReferencesPanel = memo(function PdfReferencesPanel({
	vaultPath,
	paperPath,
}: PdfReferencesPanelProps) {
	if (!paperPath) return null;

	return (
		<aside data-pdf-chrome className={cn("agentero-scroll", PDF_SIDE_PANEL)}>
			<ReferencesPanel
				vaultPath={vaultPath}
				paperPath={paperPath}
				className="h-full"
				compact
			/>
		</aside>
	);
});
