import { SquareTerminal, Terminal } from "lucide-react";
import {
	SiAlacritty,
	SiGnometerminal,
	SiIterm2,
	SiWezterm,
	SiXfce,
} from "react-icons/si";
import { cn } from "@/lib/core/utils";

/**
 * Logo for a terminal preset id (see `app/terminal/presets.rs`).
 *
 * Uses the brand mark where the icon set ships one; everything else falls back
 * to a neutral glyph so the list stays scannable without inventing artwork.
 */
export function TerminalAppLogo({
	id,
	className,
}: {
	id: string;
	className?: string;
}) {
	const iconClass = cn("size-3.5 shrink-0", className);
	switch (id) {
		case "iterm":
			return <SiIterm2 className={iconClass} aria-hidden />;
		case "gnome-terminal":
			return <SiGnometerminal className={iconClass} aria-hidden />;
		case "xfce4-terminal":
			return <SiXfce className={iconClass} aria-hidden />;
		case "alacritty":
			return <SiAlacritty className={iconClass} aria-hidden />;
		case "wezterm":
			return <SiWezterm className={iconClass} aria-hidden />;
		// Interactive shells, not emulators.
		case "powershell":
		case "cmd":
			return <Terminal className={iconClass} aria-hidden />;
		default:
			return <SquareTerminal className={iconClass} aria-hidden />;
	}
}
