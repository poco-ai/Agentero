/**
 * Left-rail panel switches (References / Figures) and the comment-rail hover id.
 *
 * Outline / References / Figures are mutually exclusive; the outline state is
 * owned by {@link usePdfOutline}, so its toggle is passed in and the two panel
 * toggles close it (and each other) before flipping their own flag.
 */

import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useState,
} from "react";

export type UsePdfSidebarPanelsOptions = {
	showOutline: boolean;
	toggleOutline: () => void;
};

export type PdfSidebarPanels = {
	showReferences: boolean;
	showFigures: boolean;
	/** Id of the comment-rail card currently being hovered; null when idle. */
	hoveredCommentId: string | null;
	setHoveredCommentId: Dispatch<SetStateAction<string | null>>;
	handleToggleOutline: () => void;
	handleToggleReferences: () => void;
	handleToggleFigures: () => void;
};

export function usePdfSidebarPanels({
	showOutline,
	toggleOutline,
}: UsePdfSidebarPanelsOptions): PdfSidebarPanels {
	const [showReferences, setShowReferences] = useState(false);
	const [showFigures, setShowFigures] = useState(false);
	const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);

	const handleToggleOutline = useCallback(() => {
		if (showReferences) setShowReferences(false);
		if (showFigures) setShowFigures(false);
		toggleOutline();
	}, [showReferences, showFigures, toggleOutline]);
	const handleToggleReferences = useCallback(() => {
		if (showOutline) toggleOutline();
		if (showFigures) setShowFigures(false);
		setShowReferences((v) => !v);
	}, [showOutline, showFigures, toggleOutline]);
	const handleToggleFigures = useCallback(() => {
		if (showOutline) toggleOutline();
		if (showReferences) setShowReferences(false);
		setShowFigures((v) => !v);
	}, [showOutline, showReferences, toggleOutline]);

	return {
		showReferences,
		showFigures,
		hoveredCommentId,
		setHoveredCommentId,
		handleToggleOutline,
		handleToggleReferences,
		handleToggleFigures,
	};
}
