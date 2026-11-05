/**
 * Lightweight selection toolbar for Plaza text surfaces (RSS detail).
 * Quick chat / Add to chat — no highlight / note / translate (nothing to persist).
 * Selected text is copied to the clipboard automatically.
 */

import { useTranslation } from "react-i18next";
import {
	SelectionToolbar,
	SelectionToolbarAction,
} from "@/components/selection/selection-toolbar";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";

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
		<SelectionToolbar
			data-plaza-selection-menu
			dimmed={overContent}
			className="fixed z-50"
			style={{ left, top }}
			aria-label={t("selection.menuLabel")}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<SelectionToolbarAction
				label={t("selection.quickChat")}
				shortcut={quickChatShortcut}
				onClick={onAsk}
			/>
			<SelectionToolbarAction
				label={t("selection.addToChat")}
				shortcut={addToChatShortcut}
				onClick={onAddToChat}
			/>
		</SelectionToolbar>
	);
}
