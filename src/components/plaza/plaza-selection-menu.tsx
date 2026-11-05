/**
 * Lightweight selection toolbar for Plaza text surfaces (RSS detail).
 * Quick chat / Add to chat — no highlight / note / translate (nothing to persist).
 * Selected text is copied to the clipboard automatically.
 */

import { useTranslation } from "react-i18next";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { cn } from "@/lib/core/utils";

export type PlazaSelectionScreen = { x: number; y: number };

type PlazaSelectionMenuProps = {
	screen: PlazaSelectionScreen;
	onAsk: () => void;
	onAddToChat: () => void;
};

const BAR_H = 32;

export function PlazaSelectionMenu({
	screen,
	onAsk,
	onAddToChat,
}: PlazaSelectionMenuProps) {
	const { t } = useTranslation("viewer");
	const quickChatShortcut = useShortcutLabel("quickChat");
	const addToChatShortcut = useShortcutLabel("addSelectionToChat");

	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const barW = 220;
	let left = screen.x - barW / 2;
	left = Math.min(Math.max(12, left), vw - barW - 12);
	let top = screen.y - BAR_H - 10;
	let overContent = false;
	if (top < 12) {
		top = Math.min(vh - BAR_H - 12, screen.y + 18);
		overContent = true;
	}

	return (
		<div
			data-plaza-selection-menu
			className={cn(
				"fixed z-50 flex h-8 items-center gap-0.5 rounded-lg border border-border/80 bg-background px-1 shadow-overlay ring-1 ring-foreground/10",
				overContent &&
					"bg-background/80 backdrop-blur-sm transition-[background-color] duration-150 hover:bg-background",
			)}
			style={{ left, top }}
			role="toolbar"
			aria-label={t("selection.menuLabel")}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<button
				type="button"
				className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100"
				aria-label={`${t("selection.quickChat")} ${quickChatShortcut}`}
				onClick={onAsk}
			>
				<span>{t("selection.quickChat")}</span>
				<kbd className="translate-y-px scale-90 text-caption font-normal text-muted-foreground/80 tabular-nums">
					{quickChatShortcut}
				</kbd>
			</button>
			<button
				type="button"
				className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100"
				aria-label={`${t("selection.addToChat")} ${addToChatShortcut}`}
				onClick={onAddToChat}
			>
				<span>{t("selection.addToChat")}</span>
				<kbd className="translate-y-px scale-90 text-caption font-normal text-muted-foreground/80 tabular-nums">
					{addToChatShortcut}
				</kbd>
			</button>
		</div>
	);
}
