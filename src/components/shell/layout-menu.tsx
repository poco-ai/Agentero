import { PanelsTopLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LayoutMode } from "@/lib/shell/ui-store";
import { dockHandle } from "@/lib/workspace/dock-registry";

type LayoutMenuProps = {
	value: LayoutMode;
	onValueChange: (mode: Exclude<LayoutMode, "custom">) => void;
};

/** Title-bar menu for the three paper-reading workbench presets. */
export function LayoutMenu({ value, onValueChange }: LayoutMenuProps) {
	const { t } = useTranslation("app");
	const [open, setOpen] = useState(false);
	const closeTimer = useRef<number | undefined>(undefined);
	/** Clicked open: hover-out must not dismiss it; outside click still does. */
	const pinned = useRef(false);
	const isReading =
		value === "reading" || Boolean(dockHandle()?.isMaximizedPanel?.());
	const selected = isReading ? "reading" : value === "custom" ? "" : value;

	const cancelClose = () => window.clearTimeout(closeTimer.current);
	const scheduleClose = () => {
		cancelClose();
		if (pinned.current) return;
		closeTimer.current = window.setTimeout(() => setOpen(false), 150);
	};

	const handleOpenChange = (next: boolean) => {
		if (!next) pinned.current = false;
		setOpen(next);
	};

	useEffect(() => () => window.clearTimeout(closeTimer.current), []);

	return (
		<DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("titlebar.layout")}
					className="active:scale-95 data-[state=open]:bg-muted data-[state=open]:text-foreground"
					onPointerDown={(event) => {
						// Hover already opened the menu. Prevent Radix's trigger toggle
						// from closing it, and pin it open instead.
						if (open && !pinned.current) {
							event.preventDefault();
							pinned.current = true;
						} else if (!open) {
							pinned.current = true;
						}
					}}
					onMouseEnter={() => {
						cancelClose();
						if (!open) {
							pinned.current = false;
							setOpen(true);
						}
					}}
					onMouseLeave={scheduleClose}
				>
					<PanelsTopLeft className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-48"
				onMouseEnter={cancelClose}
				onMouseLeave={scheduleClose}
			>
				<DropdownMenuLabel>{t("titlebar.layoutModes")}</DropdownMenuLabel>
				{/*
				 * Use `onSelect` rather than the group's `onValueChange`: the
				 * controlled value is empty in custom mode, so re-selecting the
				 * current preset (or toggling Reading off) must still fire.
				 */}
				<DropdownMenuRadioGroup value={selected}>
					<DropdownMenuRadioItem
						value="agent"
						onSelect={() => onValueChange("agent")}
					>
						{t("titlebar.layoutAgent")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem
						value="notes"
						onSelect={() => onValueChange("notes")}
					>
						{t("titlebar.layoutNotes")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem
						value="reading"
						onSelect={() => onValueChange("reading")}
					>
						{t("titlebar.layoutReading")}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
