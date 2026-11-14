import { useCallback, useEffect, useRef, useState } from "react";

/** One display preference for PDF overlays and continuous reading paragraphs. */
export function usePdfTranslationDisplay({
	docId,
	hasTranslations,
	active,
	busy,
	restore,
	closeSelection,
}: {
	docId: string;
	hasTranslations: boolean;
	active: boolean;
	busy: boolean;
	restore: () => void;
	closeSelection: () => void;
}) {
	const [hiddenDocument, setHiddenDocument] = useState<string | null>(null);
	const visible = hiddenDocument !== docId;
	const requested = useRef<string | null>(null);
	useEffect(() => {
		if (!visible || !hasTranslations || active || busy) return;
		if (requested.current === docId) return;
		requested.current = docId;
		restore();
	}, [docId, visible, hasTranslations, active, busy, restore]);
	const toggle = useCallback(() => {
		closeSelection();
		if (!visible) requested.current = null;
		setHiddenDocument(visible ? docId : null);
	}, [docId, visible, closeSelection]);
	const show = useCallback(() => setHiddenDocument(null), []);
	return { visible, toggle, show };
}
