import { Copy } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FloatingMenu, FloatingMenuItem } from "@/components/ui/floating-menu";
import { copyTextToClipboard } from "@/lib/core/clipboard";

export type FormulaContextMenuState = {
	tex: string;
	x: number;
	y: number;
};

export function FormulaContextMenu({
	menu,
	onClose,
}: {
	menu: FormulaContextMenuState;
	onClose: () => void;
}) {
	const { t } = useTranslation("aiElements");
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onPointer = (event: PointerEvent) => {
			const element = menuRef.current;
			if (
				element &&
				event.target instanceof Node &&
				element.contains(event.target)
			) {
				return;
			}
			onClose();
		};
		// Defer so the opening contextmenu event does not immediately close it.
		const timer = window.setTimeout(() => {
			window.addEventListener("pointerdown", onPointer, true);
			window.addEventListener("keydown", onKey, true);
			window.addEventListener("scroll", onClose, true);
			window.addEventListener("resize", onClose);
		}, 0);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("pointerdown", onPointer, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", onClose, true);
			window.removeEventListener("resize", onClose);
		};
	}, [onClose]);

	const copyFormula = () => {
		onClose();
		void copyTextToClipboard(menu.tex, {
			successMessage: t("formula.copied"),
			errorMessage: t("formula.copyFailed"),
		});
	};

	return (
		<FloatingMenu
			floatingRef={menuRef}
			point={{ x: menu.x, y: menu.y }}
			className="z-[2000] min-w-44"
		>
			<FloatingMenuItem onClick={copyFormula}>
				<Copy className="size-3.5" aria-hidden />
				<span>{t("formula.copyLatex")}</span>
			</FloatingMenuItem>
		</FloatingMenu>
	);
}
