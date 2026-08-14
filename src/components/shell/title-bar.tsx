import {
	BookMarked,
	Bot,
	ImageIcon,
	Link2,
	MessageSquareText,
	PanelLeft,
	PanelRight,
	Settings,
} from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { VoiceDefenseTrigger } from "@/components/agent/voice-defense-trigger";
import { LayoutMenu } from "@/components/shell/layout-menu";
import { UpdateIndicator } from "@/components/shell/update-indicator";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import { moveFeatureToWindow } from "@/lib/shell/leaf";
import { formatShortcutById } from "@/lib/shell/shortcuts";

/** Platform-formatted shortcut chips for title bar tooltips (⌥⌘… on macOS, Ctrl+… elsewhere). */
const SIDEBAR_SHORTCUT = formatShortcutById("toggleSidebar");
const CHAT_SHORTCUT = formatShortcutById("toggleChat");
const SETTINGS_SHORTCUT = formatShortcutById("settings");

type TitleBarProps = {
	isMacDesktop: boolean;
	showSettingsGear: boolean;
	sidebarCollapsed: boolean;
	notesEligible: boolean;
	showNotes: boolean;
	rightSidebarOpen: boolean;
	rightSidebarTab:
		| "agent"
		| "backlinks"
		| "annotations"
		| "references"
		| "figures";
	onToggleSidebar: () => void;
	/** Toggle NOTES panel for the active paper (state lives in dockview). */
	onToggleNotes: (open?: boolean) => void;
	onToggleRightSidebar: () => void;
	onOpenRightTab: (
		tab: "agent" | "backlinks" | "annotations" | "references" | "figures",
	) => void;
	onOpenSettings: () => void;
	showViva?: boolean;
};

/**
 * Title-bar row: window chrome + sidebar / layout controls.
 * Document tabs live inside the center Dockview workspace (not here).
 */
export const TitleBar = memo(function TitleBar({
	isMacDesktop,
	showSettingsGear,
	sidebarCollapsed,
	notesEligible,
	showNotes,
	rightSidebarOpen,
	rightSidebarTab,
	onToggleSidebar,
	onToggleNotes,
	onToggleRightSidebar,
	onOpenRightTab,
	onOpenSettings,
	showViva = false,
}: TitleBarProps) {
	const { t } = useTranslation(["app"]);

	return (
		<header className="flex h-8 shrink-0 items-center border-b select-none">
			{/*
			  Traffic lights: x=14, three ~14px buttons + gaps → ends ~68px.
			  Keep extra gap so the sidebar toggle never hugs the lights.
			*/}
			{isMacDesktop ? (
				<div
					className="w-[92px] shrink-0 self-stretch"
					data-tauri-drag-region
				/>
			) : (
				<div className="w-2 shrink-0 self-stretch" data-tauri-drag-region />
			)}
			<TooltipProvider delayDuration={250}>
				<div className="flex shrink-0 items-center gap-0.5 pr-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
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
						leftSidebarOpen={!sidebarCollapsed}
						onToggleLeftSidebar={onToggleSidebar}
						notesAvailable={notesEligible}
						notesOpen={showNotes}
						onToggleNotes={onToggleNotes}
						rightSidebarOpen={rightSidebarOpen}
						onToggleRightSidebar={onToggleRightSidebar}
					/>
					{rightSidebarOpen ? (
						<>
							{showViva ? <VoiceDefenseTrigger /> : null}
							{(
								[
									{
										id: "agent" as const,
										aria: t("titlebar.agentPanel"),
										tooltip: t("labels.agent"),
										Icon: Bot,
									},
									{
										id: "backlinks" as const,
										aria: t("titlebar.backlinksPanel"),
										tooltip: t("labels.backlinks"),
										Icon: Link2,
									},
									{
										id: "annotations" as const,
										aria: t("titlebar.annotationsPanel"),
										tooltip: t("annotations.title", { ns: "viewer" }),
										Icon: MessageSquareText,
									},
									{
										id: "references" as const,
										aria: t("titlebar.referencesPanel"),
										tooltip: t("references.title", { ns: "viewer" }),
										Icon: BookMarked,
									},
									{
										id: "figures" as const,
										aria: t("titlebar.figuresPanel"),
										tooltip: t("figures.title", { ns: "viewer" }),
										Icon: ImageIcon,
									},
								] as const
							).map(({ id, aria, tooltip, Icon }) => (
								<ContextMenu key={id}>
									<Tooltip>
										<TooltipTrigger asChild>
											<ContextMenuTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													aria-label={aria}
													aria-pressed={rightSidebarTab === id}
													className={cn(
														rightSidebarTab === id &&
															"bg-muted text-foreground",
													)}
													onClick={() => onOpenRightTab(id)}
												>
													<Icon className="size-3.5" />
												</Button>
											</ContextMenuTrigger>
										</TooltipTrigger>
										<TooltipContent side="bottom">{tooltip}</TooltipContent>
									</Tooltip>
									<ContextMenuContent>
										<ContextMenuItem
											onSelect={() => {
												void moveFeatureToWindow(id);
											}}
										>
											{t("tabs.contextMoveToNewWindow")}
										</ContextMenuItem>
									</ContextMenuContent>
								</ContextMenu>
							))}
						</>
					) : null}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={
									rightSidebarOpen
										? t("titlebar.hideRightSidebar")
										: t("titlebar.showRightSidebar")
								}
								aria-pressed={rightSidebarOpen}
								onClick={onToggleRightSidebar}
							>
								<PanelRight className="size-3.5" />
							</Button>
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
				</div>
				{/*
				  Windows / Linux have no native menu bar, so Settings needs a
				  visible entry point. The gear sits at the far right of the title
				  bar (caption buttons are drawn by the OS).
				*/}
				{showSettingsGear ? (
					<div className="flex shrink-0 items-center gap-0.5 pl-1">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="group"
									aria-label={t("titlebar.settings")}
									onClick={() => onOpenSettings()}
								>
									<Settings
										className={cn(
											"size-3.5",
											"transition-transform duration-300 ease-out group-hover:rotate-90",
										)}
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("titlebar.settingsHint", {
									shortcut: SETTINGS_SHORTCUT,
								})}
							</TooltipContent>
						</Tooltip>
					</div>
				) : null}
			</TooltipProvider>
		</header>
	);
});
