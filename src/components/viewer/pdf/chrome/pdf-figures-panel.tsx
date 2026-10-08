import {
	FiguresOverlayToggle,
	FiguresPanel,
} from "@/components/viewer/panels/figures-panel";
import {
	PDF_CHROME_CHIP,
	PDF_SIDE_PANEL,
} from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { PdfForceLayoutButton } from "@/components/viewer/pdf/chrome/pdf-force-layout-button";
import { cn } from "@/lib/core/utils";
import type { PdfLayoutRegion } from "@/lib/pdf/layout";

type PdfFiguresPanelProps = {
	documentId: string;
	paperAbsPath?: string | null;
	paperRelPath?: string | null;
	showFigures: boolean;
	analyzing?: boolean;
	/** Remote arXiv papers have no local PDF sidecar to replace. */
	isRemotePaper?: boolean;
	onAnalyze: () => void;
	onJump: (region: PdfLayoutRegion) => void;
	onRenderThumb: (region: PdfLayoutRegion) => Promise<{
		mimeType: string;
		data: string;
	} | null>;
};

/** Left-side layout analysis panel. The overlay Eye toggle sits top-right,
 *  sharing the left toolbar's row. */
export function PdfFiguresPanel({
	documentId,
	paperAbsPath,
	paperRelPath,
	showFigures,
	analyzing,
	isRemotePaper = false,
	onAnalyze,
	onJump,
	onRenderThumb,
}: PdfFiguresPanelProps) {
	if (!showFigures) return null;

	return (
		<aside data-pdf-chrome className={cn("overflow-hidden", PDF_SIDE_PANEL)}>
			{/* Same row as the left toolbar (top-2 / h-7), right-aligned chips.
			    Force re-parse sits immediately left of the overlay toggle. */}
			<div className="absolute top-2 right-3 z-10 flex items-center gap-1">
				<PdfForceLayoutButton
					paperAbsPath={paperAbsPath}
					paperRelPath={paperRelPath}
					isRemotePaper={isRemotePaper}
					className={cn(
						"flex h-7 items-center rounded-lg p-0.5",
						PDF_CHROME_CHIP,
					)}
				/>
				<FiguresOverlayToggle
					documentId={documentId}
					className={cn(
						"flex h-7 items-center rounded-lg p-0.5",
						PDF_CHROME_CHIP,
					)}
				/>
			</div>
			<FiguresPanel
				documentId={documentId}
				paperAbsPath={paperAbsPath}
				paperRelPath={paperRelPath}
				viewerReady
				analyzing={analyzing}
				onAnalyze={onAnalyze}
				onJump={onJump}
				onRenderThumb={onRenderThumb}
				className="h-full"
				compact
			/>
		</aside>
	);
}
