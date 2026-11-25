/**
 * Hover handles on both edges of the centered conversation column. Dragging
 * either edge resizes the column symmetrically, so it stays centered and the
 * grabbed edge follows the pointer.
 */

import { useTranslation } from "react-i18next";
import {
	DEFAULT_CONVERSATION_WIDTH,
	MAX_CONVERSATION_WIDTH,
	MIN_CONVERSATION_WIDTH,
	maxConversationWidthFor,
} from "@/lib/agent/conversation-width";
import { cn } from "@/lib/core/utils";

const STEP_PX = 16;

type Side = "left" | "right";

function ConversationWidthHandle({
	side,
	width,
	onChange,
}: {
	side: Side;
	width: number;
	onChange: (px: number) => void;
}) {
	const { t } = useTranslation("agent");
	const label = t("composer.resizeConversationWidth");
	const sign = side === "right" ? 1 : -1;
	// The column can widen until it sits one margin away from the panel edge.
	const panelMax = (el: HTMLElement): number => {
		const panel = el.parentElement?.parentElement;
		return panel
			? Math.min(
					MAX_CONVERSATION_WIDTH,
					maxConversationWidthFor(panel.clientWidth),
				)
			: MAX_CONVERSATION_WIDTH;
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: an <hr> is void and cannot host the grip
		<div
			role="separator"
			aria-label={label}
			aria-orientation="vertical"
			aria-valuemin={MIN_CONVERSATION_WIDTH}
			aria-valuemax={MAX_CONVERSATION_WIDTH}
			aria-valuenow={width}
			tabIndex={0}
			title={label}
			className={cn(
				"group/col-resize absolute inset-y-0 z-30 w-6 cursor-col-resize touch-none outline-none",
				// Line the hit area / bar up with the composer card's outer edge:
				// the wide composer is inset 1.25rem (2.5rem at lg) inside the column.
				side === "left" ? "left-2 lg:left-7" : "right-2 lg:right-7",
			)}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				const startX = event.clientX;
				const startWidth = width;
				const previousUserSelect = document.body.style.userSelect;
				const previousCursor = document.body.style.cursor;
				const handle = event.currentTarget;
				const limit = panelMax(handle);
				document.body.style.userSelect = "none";
				document.body.style.cursor = "col-resize";
				const onMove = (move: PointerEvent) => {
					const delta =
						side === "right" ? move.clientX - startX : startX - move.clientX;
					onChange(Math.min(limit, startWidth + delta * 2));
				};
				const finish = () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", finish);
					window.removeEventListener("pointercancel", finish);
					document.body.style.userSelect = previousUserSelect;
					document.body.style.cursor = previousCursor;
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", finish);
				window.addEventListener("pointercancel", finish);
			}}
			onDoubleClick={() => onChange(DEFAULT_CONVERSATION_WIDTH)}
			onKeyDown={(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const direction = event.key === "ArrowRight" ? 1 : -1;
				onChange(
					Math.min(
						panelMax(event.currentTarget),
						width + direction * sign * STEP_PX,
					),
				);
			}}
		>
			{/* No resting rule: the column should read as an open canvas. Only the
			    drag bar appears while the edge is hovered, focused, or dragged. */}
			<span className="pointer-events-none absolute top-1/2 left-1/2 h-24 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/35 opacity-0 transition-opacity duration-100 group-hover/col-resize:opacity-100 group-focus-visible/col-resize:opacity-100 group-active/col-resize:opacity-100" />
		</div>
	);
}

export function ConversationWidthHandles({
	width,
	onChange,
}: {
	width: number;
	onChange: (px: number) => void;
}) {
	return (
		<>
			<ConversationWidthHandle side="left" width={width} onChange={onChange} />
			<ConversationWidthHandle side="right" width={width} onChange={onChange} />
		</>
	);
}
