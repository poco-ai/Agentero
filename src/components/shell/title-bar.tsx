import { ArrowUpRight, PanelLeft, Settings, X } from "lucide-react";
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { LayoutMenu } from "@/components/shell/layout-menu";
import { QuickOpen } from "@/components/shell/quick-open";
import { TrafficLightSpacer } from "@/components/shell/traffic-light-spacer";
import { UpdateIndicator } from "@/components/shell/update-indicator";
import { WindowControls } from "@/components/shell/window-controls";
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
	/** Whole-window Agent workspace is open. */
	agentWindowOpen: boolean;
	/** A vault is open, so the Agent workspace has a session list. */
	agentWindowAvailable: boolean;
	sidebarCollapsed: boolean;
	rightSidebarOpen: boolean;
	layoutMode: LayoutMode;
	onToggleSidebar: () => void;
	onToggleAgent: () => void;
	onToggleAgentWindow: () => void;
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
	agentWindowOpen,
	agentWindowAvailable,
	sidebarCollapsed,
	rightSidebarOpen,
	layoutMode,
	onToggleSidebar,
	onToggleAgent,
	onToggleAgentWindow,
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
	const [agentRailMenuOpen, setAgentRailMenuOpen] = useState(false);
	// Palette entries in the gear menu hand focus to the title-bar field; stop
	// Radix from restoring focus to the gear when that menu closes.
	const paletteMenuOpenRef = useRef(false);
	// Right-click opens the menu. Left-click on the same trigger asks Radix to
	// open it too; only a gesture we just marked may do that.
	const agentRailMenuOpenedAt = useRef(0);
	const openAgentRailMenu = () => {
		agentRailMenuOpenedAt.current = performance.now();
		setAgentRailMenuOpen(true);
	};

	return (
		<WindowHeader className="relative z-40">
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
				{/*
				 * Middle: drag region plus the inline quick open (⌘P), centered
				 * on the window rather than on the space between the controls.
				 */}
				<div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2">
					{agentWindowAvailable ? (
						// Invisible twin keeps the search field optically centered while
						// the Agent card shrinks to its label.
						<span
							aria-hidden
							className="pointer-events-none invisible flex h-[1.375rem] shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 text-xs"
						>
							<span className="min-w-0 truncate">
								{t("titlebar.agentWindow")}
							</span>
							<ArrowUpRight className="size-3 shrink-0" />
						</span>
					) : null}
					<div className="pointer-events-auto">
						<QuickOpen />
					</div>
					{agentWindowAvailable ? (
						<button
							type="button"
							aria-label={t("titlebar.agentWindow")}
							aria-pressed={agentWindowOpen}
							title={t("titlebar.agentWindow")}
							onClick={onToggleAgentWindow}
							className={cn(
								"pointer-events-auto flex h-[1.375rem] shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 text-xs transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none",
								agentWindowOpen
									? "border-brand/40 bg-brand/20 text-brand"
									: "border-brand/20 bg-brand/10 text-brand hover:bg-brand/15",
							)}
						>
							<span className="min-w-0 truncate">
								{t("titlebar.agentWindow")}
							</span>
							{agentWindowOpen ? (
								<X className="size-3 shrink-0" aria-hidden />
							) : (
								<ArrowUpRight
									className="size-3 shrink-0 opacity-70"
									aria-hidden
								/>
							)}
						</button>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-0.5 pr-2">
					<UpdateIndicator />
					{agentWindowOpen ? null : (
						<LayoutMenu
							value={layoutMode}
							onValueChange={onApplyLayoutMode}
							onToggleImmersive={onToggleImmersive}
						/>
					)}
					{agentWindowOpen ? null : (
						<>
							{/*
							 * Left click toggles the rail. Right click opens this menu.
							 * A cursor-anchored context menu is clipped against the right
							 * edge on Windows, and WebView2 often never emits contextmenu
							 * here, so the right button opens a menu anchored to the button.
							 */}
							<DropdownMenu
								open={agentRailMenuOpen}
								onOpenChange={(next) => {
									if (
										next &&
										performance.now() - agentRailMenuOpenedAt.current > 500
									) {
										return;
									}
									if (!next) agentRailMenuOpenedAt.current = 0;
									setAgentRailMenuOpen(next);
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
													openAgentRailMenu();
												}}
												onContextMenu={(event) => {
													event.preventDefault();
													openAgentRailMenu();
												}}
												onClick={(event) => {
													event.preventDefault();
													if (agentRailMenuOpen) return;
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
										if (
											performance.now() - agentRailMenuOpenedAt.current <
											400
										) {
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
						</>
					)}
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
							<DropdownMenuContent
								align="end"
								className="min-w-56"
								onCloseAutoFocus={(event) => {
									if (!paletteMenuOpenRef.current) return;
									paletteMenuOpenRef.current = false;
									event.preventDefault();
								}}
							>
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
								<DropdownMenuItem
									onSelect={() => {
										paletteMenuOpenRef.current = true;
										openPalette("go");
									}}
								>
									<span className="flex-1">{t("titlebar.menuQuickOpen")}</span>
									<span className="text-muted-foreground text-xs tracking-wide">
										{QUICK_OPEN_SHORTCUT}
									</span>
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={() => {
										paletteMenuOpenRef.current = true;
										openPalette("commands");
									}}
								>
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
					<WindowControls className="pl-1" />
				</div>
			</TooltipProvider>
		</WindowHeader>
	);
});
