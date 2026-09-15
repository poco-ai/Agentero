import { PanelLeft, Settings } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { LayoutMenu } from "@/components/shell/layout-menu";
import { TrafficLightSpacer } from "@/components/shell/traffic-light-spacer";
import { UpdateIndicator } from "@/components/shell/update-indicator";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentChromeStore } from "@/lib/agent/agent-chrome-store";
import { cn } from "@/lib/core/utils";
import { moveFeatureToWindow } from "@/lib/shell/leaf";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import type { LayoutMode } from "@/lib/shell/ui-store";
import { openPalette } from "@/lib/shell/ui-store";

/** Platform-formatted shortcut chips for title bar tooltips (⌥⌘… on macOS, Ctrl+… elsewhere). */
const SIDEBAR_SHORTCUT = formatShortcutById("toggleSidebar");
const CHAT_SHORTCUT = formatShortcutById("toggleChat");
const SETTINGS_SHORTCUT = formatShortcutById("settings");
const QUICK_OPEN_SHORTCUT = formatShortcutById("quickOpen");
const COMMAND_PALETTE_SHORTCUT = formatShortcutById("commandPalette");

type TitleBarProps = {
	isMacDesktop: boolean;
	showSettingsGear: boolean;
	sidebarCollapsed: boolean;
	rightSidebarOpen: boolean;
	layoutMode: LayoutMode;
	onToggleSidebar: () => void;
	onToggleAgent: () => void;
	onApplyLayoutMode: (mode: Exclude<LayoutMode, "custom">) => void;
	onOpenSettings: () => void;
};

/**
 * Title-bar row: window chrome + sidebar / layout controls.
 * Document tabs live inside the center Dockview workspace (not here).
 */
export const TitleBar = memo(function TitleBar({
	isMacDesktop,
	showSettingsGear,
	sidebarCollapsed,
	rightSidebarOpen,
	layoutMode,
	onToggleSidebar,
	onToggleAgent,
	onApplyLayoutMode,
	onOpenSettings,
}: TitleBarProps) {
	const { t } = useTranslation(["app"]);
	const agentTemplate = useAgentChromeStore((s) => s.template);

	return (
		<header
			data-titlebar
			className="flex h-8 shrink-0 items-center border-b border-border/50 bg-background/75 backdrop-blur-xl backdrop-saturate-150 supports-backdrop-blur:bg-background/65 select-none"
		>
			{/* Collapses in native fullscreen, where macOS hides the lights. */}
			{isMacDesktop ? (
				<TrafficLightSpacer />
			) : (
				<div className="w-2 shrink-0 self-stretch" data-tauri-drag-region />
			)}
			<TooltipProvider delayDuration={250}>
				<div className="flex shrink-0 items-center gap-0.5 pr-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-xs"
								data-tb-sidebar
								aria-label={
									sidebarCollapsed
										? t("titlebar.showLeftSidebar")
										: t("titlebar.hideLeftSidebar")
								}
								aria-pressed={!sidebarCollapsed}
								onClick={onToggleSidebar}
							>
								<PanelLeft className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{sidebarCollapsed
								? t("titlebar.showSidebarHint", {
										shortcut: SIDEBAR_SHORTCUT,
									})
								: t("titlebar.hideSidebarHint", {
										shortcut: SIDEBAR_SHORTCUT,
									})}
						</TooltipContent>
					</Tooltip>
				</div>
				{/* Drag region fills the middle — document tabs are in dockview. */}
				<div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
				<div className="flex shrink-0 items-center gap-0.5 pr-2">
					<UpdateIndicator />
					<LayoutMenu value={layoutMode} onValueChange={onApplyLayoutMode} />
					<ContextMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<ContextMenuTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										data-tb-agent
										aria-label={
											rightSidebarOpen
												? t("titlebar.hideRightSidebar")
												: t("titlebar.showRightSidebar")
										}
										aria-pressed={rightSidebarOpen}
										className={cn(
											rightSidebarOpen && "bg-muted text-foreground",
										)}
										onClick={onToggleAgent}
									>
										<AgentLogo
											template={agentTemplate}
											className="size-3.5"
											iconClassName="size-3"
											plain
										/>
									</Button>
								</ContextMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{rightSidebarOpen
									? t("titlebar.hideRightSidebarHint", {
											shortcut: CHAT_SHORTCUT,
										})
									: t("titlebar.showRightSidebarHint", {
											shortcut: CHAT_SHORTCUT,
										})}
							</TooltipContent>
						</Tooltip>
						<ContextMenuContent>
							<ContextMenuItem
								onSelect={() => {
									void moveFeatureToWindow("agent");
								}}
							>
								{t("tabs.contextMoveToNewWindow")}
							</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
					{/*
				  Windows / Linux have no native menu bar, so the gear doubles as a
				  compact app menu: settings entries plus the palette actions that
				  otherwise only exist as keyboard shortcuts (discoverability).
				  Caption buttons are drawn by the OS.
				*/}
					{showSettingsGear ? (
						<DropdownMenu>
							<Tooltip>
								<TooltipTrigger asChild>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											aria-label={t("titlebar.settings")}
										>
											<Settings className="size-3.5" />
										</Button>
									</DropdownMenuTrigger>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("titlebar.settingsHint", {
										shortcut: SETTINGS_SHORTCUT,
									})}
								</TooltipContent>
							</Tooltip>
							<DropdownMenuContent align="end" className="min-w-56">
								<DropdownMenuItem onSelect={() => onOpenSettings()}>
									<span className="flex-1">{t("titlebar.menuSettings")}</span>
									<span className="text-muted-foreground text-xs tracking-wide">
										{SETTINGS_SHORTCUT}
									</span>
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={() => openSettingsWindow("keyboard")}
								>
									<span className="flex-1">
										{t("titlebar.menuKeyboardShortcuts")}
									</span>
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => openPalette("go")}>
									<span className="flex-1">{t("titlebar.menuQuickOpen")}</span>
									<span className="text-muted-foreground text-xs tracking-wide">
										{QUICK_OPEN_SHORTCUT}
									</span>
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => openPalette("commands")}>
									<span className="flex-1">
										{t("titlebar.menuCommandPalette")}
									</span>
									<span className="text-muted-foreground text-xs tracking-wide">
										{COMMAND_PALETTE_SHORTCUT}
									</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
			</TooltipProvider>
		</header>
	);
});
