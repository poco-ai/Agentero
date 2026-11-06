import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";

const LABEL_DURATION_MS = 1000;
const LABEL_OFFSET_X = 12;
const LABEL_OFFSET_Y = -28;

type SelectionCopiedLabelProps = {
	x: number;
	y: number;
};

/**
 * A tiny ephemeral pill shown at the mouse position confirming that the
 * selected text was copied to the clipboard.
 */
export function SelectionCopiedLabel({ x, y }: SelectionCopiedLabelProps) {
	const { t } = useTranslation("viewer");
	const [visible, setVisible] = useState(true);

	useEffect(() => {
		const timer = setTimeout(() => setVisible(false), LABEL_DURATION_MS);
		return () => clearTimeout(timer);
	}, []);

	if (!visible || typeof document === "undefined") return null;

	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const labelWidth = 64;
	const labelHeight = 22;
	let left = x + LABEL_OFFSET_X;
	let top = y + LABEL_OFFSET_Y;
	left = Math.min(Math.max(8, left), vw - labelWidth - 8);
	top = Math.min(Math.max(8, top), vh - labelHeight - 8);

	return createPortal(
		<div
			className={cn(
				"pointer-events-none fixed z-50 inline-flex h-5 items-center rounded-full border border-border/80 bg-background/95 px-2 text-caption font-medium text-foreground shadow-raised ring-1 ring-foreground/10 backdrop-blur-sm animate-in fade-in zoom-in-95",
			)}
			style={{ left, top }}
			role="status"
			aria-live="polite"
		>
			{t("selection.copied")}
		</div>,
		document.body,
	);
}
