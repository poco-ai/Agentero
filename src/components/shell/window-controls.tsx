import type { Window } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { isTauri, isWindows } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";

/**
 * Caption buttons (minimize / maximize / close) for the frameless Windows
 * title bar.
 *
 * Only Windows windows are frameless (macOS keeps its Overlay traffic lights,
 * Linux keeps native decorations), so the component renders nothing elsewhere.
 * Render it inside a `TooltipProvider` at the end of the 32px `WindowHeader`
 * row, where the OS would normally draw its caption buttons.
 */
export function WindowControls({ className }: { className?: string }) {
	const { t } = useTranslation("app");
	const [maximized, setMaximized] = useState(false);
	const enabled = isTauri() && isWindows();

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void (async () => {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			const win = getCurrentWindow();
			const sync = async () => {
				try {
					const next = await win.isMaximized();
					if (!cancelled) setMaximized(next);
				} catch {
					// Window state is best-effort; keep the last known value.
				}
			};
			await sync();
			const un = await win.onResized(() => {
				void sync();
			});
			if (cancelled) {
				un();
				return;
			}
			unlisten = un;
		})();
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [enabled]);

	const withWindow = (action: (win: Window) => Promise<void>) => {
		void (async () => {
			if (!enabled) return;
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			try {
				await action(getCurrentWindow());
			} catch {
				// The window op is unavailable outside the desktop app.
			}
		})();
	};

	const maximizeLabel = maximized
		? t("titlebar.restore")
		: t("titlebar.maximize");

	if (!enabled) return null;

	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-0.5 self-stretch",
				className,
			)}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("titlebar.minimize")}
						onClick={() => withWindow((win) => win.minimize())}
					>
						<Minus className="size-3.5" />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("titlebar.minimize")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={maximizeLabel}
						onClick={() => withWindow((win) => win.toggleMaximize())}
					>
						{maximized ? (
							<Copy className="size-3" />
						) : (
							<Square className="size-3" />
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">{maximizeLabel}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("titlebar.close")}
						className="hover:bg-destructive hover:text-destructive-foreground"
						onClick={() => withWindow((win) => win.close())}
					>
						<X className="size-3.5" />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("titlebar.close")}</TooltipContent>
			</Tooltip>
		</div>
	);
}
