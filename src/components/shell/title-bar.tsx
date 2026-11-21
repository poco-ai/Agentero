import { PanelLeft, Settings } from "lucide-react";
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { LayoutMenu } from "@/components/shell/layout-menu";
import { TrafficLightSpacer } from "@/components/shell/traffic-light-spacer";
import { UpdateIndicator } from "@/components/shell/update-indicator";
import { WindowHeader } from "@/components/shell/window-header";
import { Button } from "@/components/ui/button";
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
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { useAgentChromeStore } from "@/lib/agent/agent-chrome-store";
import { cn } from "@/lib/core/utils";
import { moveFeatureToWindow } from "@/lib/shell/leaf";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import type { LayoutMode } from "@/lib/shell/ui-store";
import { openPalette } from "@/lib/shell/ui-store";

type TitleBarProps = {
	isMacDesktop: boolean;
	showSettingsGear: boolean;
	sidebarCollapsed: boolean;
	rightSidebarOpen: boolean;
	layoutMode: LayoutMode;
	onToggleSidebar: () => void;
	onToggleAgent: () => void;
	onApplyLayoutMode: (mode: Exclude<LayoutMode, "custom">) => void;
	onToggleImmersive: () => void;
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
	onToggleImmersive,
	onOpenSettings,
}: TitleBarProps) {
	const { t } = useTranslation(["app"]);
	const SIDEBAR_SHORTCUT = useShortcutLabel("toggleSidebar");
	const CHAT_SHORTCUT = useShortcutLabel("toggleChat");
	const SETTINGS_SHORTCUT = useShortcutLabel("settings");
	const QUICK_OPEN_SHORTCUT = useShortcutLabel("quickOpen");
	const COMMAND_PALETTE_SHORTCUT = useShortcutLabel("commandPalette");
	const agentTemplate = useAgentChromeStore((s) => s.template);
	const [agentWindowMenuOpen, setAgentWindowMenuOpen] = useState(false);
	// Right-click opens the menu. Left-click on the same trigger asks Radix to
	// open it too; only a gesture we just marked may do that.
	const agentWindowMenuOpenedAt = useRef(0);
	const openAgentWindowMenu = () => {
		agentWindowMenuOpenedAt.current = performance.now();
		setAgentWindowMenuOpen(true);
	};

	return (
		<WindowHeader>
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
								size="icon-sm"
								data-tb-sidebar
								data-hint
								data-hint-priority="1"
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
					<LayoutMenu
						value={layoutMode}
						onValueChange={onApplyLayoutMode}
						onToggleImmersive={onToggleImmersive}
					/>
					{/*
					 * Left click toggles the rail. Right click opens this menu.
					 * A cursor-anchored context menu is clipped against the right
					 * edge on Windows, and WebView2 often never emits contextmenu
					 * here, so the right button opens a menu anchored to the button.
					 */}
					<DropdownMenu
						open={agentWindowMenuOpen}
						onOpenChange={(next) => {
							if (
								next &&
								performance.now() - agentWindowMenuOpenedAt.current > 500
							) {
								return;
							}
							if (!next) agentWindowMenuOpenedAt.current = 0;
							setAgentWindowMenuOpen(next);
						}}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										data-tb-agent
										data-hint
										data-hint-priority="1"
										aria-label={
											rightSidebarOpen
												? t("titlebar.hideRightSidebar")
												: t("titlebar.showRightSidebar")
										}
										aria-pressed={rightSidebarOpen}
										className={cn(
											rightSidebarOpen && "bg-muted text-foreground",
										)}
										onPointerDown={(event) => {
											if (event.button !== 2) return;
											event.stopPropagation();
											openAgentWindowMenu();
										}}
										onContextMenu={(event) => {
											event.preventDefault();
											openAgentWindowMenu();
										}}
										onClick={(event) => {
											event.preventDefault();
											if (agentWindowMenuOpen) return;
											onToggleAgent();
										}}
									>
										<AgentLogo
											template={agentTemplate}
											className="size-3.5"
											iconClassName="size-3"
											plain
										/>
									</Button>
								</DropdownMenuTrigger>
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
						<DropdownMenuContent
							align="end"
							className="min-w-40"
							onInteractOutside={(event) => {
								if (performance.now() - agentWindowMenuOpenedAt.current < 400) {
									event.preventDefault();
								}
							}}
						>
							<DropdownMenuItem
								onSelect={() => {
									void moveFeatureToWindow("agent");
								}}
							>
								{t("tabs.contextMoveToNewWindow")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
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
											size="icon-sm"
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
		</WindowHeader>
	);
});
