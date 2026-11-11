import { type RefObject, useEffect, useRef } from "react";
import { ownsPdfKeyboard } from "@/lib/pdf/keyboard-ownership";

export function PdfHistoryKeyHandler({
	active,
	hostRef,
	onReplay,
}: {
	active: boolean;
	hostRef: RefObject<HTMLDivElement | null>;
	onReplay: (redo: boolean) => void;
}) {
	const latest = useRef({ active, onReplay });
	latest.current = { active, onReplay };
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				event.altKey ||
				!(event.metaKey || event.ctrlKey) ||
				event.key.toLowerCase() !== "z" ||
				!ownsPdfKeyboard({
					target: event.target,
					host: hostRef.current,
					active: latest.current.active,
				})
			)
				return;
			event.preventDefault();
			event.stopImmediatePropagation();
			latest.current.onReplay(event.shiftKey);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [hostRef]);
	return null;
}
