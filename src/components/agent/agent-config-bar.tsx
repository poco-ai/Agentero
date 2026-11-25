import { CheckIcon, ChevronDown, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ComposerModelSelector } from "@/components/agent/composer/composer-model-selector";
import { PromptInputButton } from "@/components/agent/composer/prompt-input";
import type { GroupedModel } from "@/components/agent/hooks/use-agent-config";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroupButton } from "@/components/ui/input-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
	AgentEffortChoice,
	AgentModeChoice,
	AgentModelChoice,
} from "@/lib/agent";
import { cn } from "@/lib/core/utils";

export type AgentConfigBarProps = {
	modelSelectorOpen: boolean;
	onModelSelectorOpenChange: (open: boolean) => void;
	models: AgentModelChoice[];
	groupedModels: GroupedModel[];
	modelId: string | null;
	selectedModelName: string | null;
	favoriteIds: string[];
	warming: boolean;
	onPickModel: (id: string) => void;
	onToggleFavorite: (id: string) => void;
	collaborationOptions: AgentModeChoice[];
	collaborationModeId: string | null;
	selectedCollaborationName: string | null;
	onPickCollaborationMode: (id: string) => void;
	effortOptions: AgentEffortChoice[];
	reasoningEffort: string | null;
	onReasoningEffortChange: (id: string) => void;
	fastAvailable: boolean;
	fastEnabled: boolean;
	onFastEnabledToggle: () => void;
};

/** Agent collaboration mode picker (Default / Plan / …). */
export function ComposerCollaborationSelector({
	options,
	value,
	selectedName,
	onPick,
	labelPrefix = true,
	icon,
}: {
	options: AgentModeChoice[];
	value: string | null;
	selectedName: string | null;
	onPick: (id: string) => void;
	/** Rail config bar shows “Mode: …”; the workspace composer foot shows just the name. */
	labelPrefix?: boolean;
	icon?: ReactNode;
}) {
	const { t } = useTranslation("agent");
	if (options.length === 0) return null;
	const label = selectedName ?? value ?? t("composer.collaboration.label");
	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<InputGroupButton
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 min-w-0 max-w-[min(14rem,100%)] shrink gap-1 px-1.5 text-sm font-medium text-foreground"
						>
							{labelPrefix ? null : icon}
							<span className="min-w-0 flex-1 truncate">
								{labelPrefix
									? `${t("composer.collaboration.label")}: ${label}`
									: label}
							</span>
							<ChevronDown className="size-3 shrink-0 opacity-70" />
						</InputGroupButton>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{t("composer.collaborationTooltip")}
				</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="start" className="min-w-36 p-1.5">
				{options.map((mode) => (
					<DropdownMenuItem
						key={mode.id}
						className={cn(
							"flex items-center justify-between gap-2 rounded-md",
							value === mode.id && "bg-muted",
						)}
						onSelect={() => onPick(mode.id)}
					>
						<span className="min-w-0 flex-1 truncate">{mode.name}</span>
						{value === mode.id ? (
							<CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Fast-mode toggle, shared by the rail config bar and the workspace composer foot. */
export function ComposerFastToggle({
	fastAvailable,
	fastEnabled,
	onToggle,
}: {
	fastAvailable: boolean;
	fastEnabled: boolean;
	onToggle: () => void;
}) {
	const { t } = useTranslation("agent");
	if (!fastAvailable) return null;
	return (
		<PromptInputButton
			type="button"
			className={cn(
				"size-7 text-foreground",
				fastEnabled && "text-amber-500 hover:text-amber-500",
			)}
			aria-pressed={fastEnabled}
			onClick={onToggle}
			tooltip={{
				content: t("composer.fastToggle"),
				side: "bottom",
			}}
		>
			<Zap
				className={cn(
					"size-3.5",
					fastEnabled &&
						"fill-amber-400 text-amber-500 dark:fill-amber-300 dark:text-amber-300",
				)}
			/>
		</PromptInputButton>
	);
}

/** Session config row under the pane header: model (including effort), collaboration, fast. */
export function AgentConfigBar({
	modelSelectorOpen,
	onModelSelectorOpenChange,
	models,
	groupedModels,
	modelId,
	selectedModelName,
	favoriteIds,
	warming,
	onPickModel,
	onToggleFavorite,
	collaborationOptions,
	collaborationModeId,
	selectedCollaborationName,
	onPickCollaborationMode,
	effortOptions,
	reasoningEffort,
	onReasoningEffortChange,
	fastAvailable,
	fastEnabled,
	onFastEnabledToggle,
}: AgentConfigBarProps) {
	const { t } = useTranslation("agent");

	return (
		<div
			role="toolbar"
			className="flex h-9 min-w-0 shrink-0 select-none items-center gap-1 overflow-hidden border-b bg-muted/15 px-3"
			aria-label={t("configBar.label")}
		>
			<div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden">
				<ComposerModelSelector
					open={modelSelectorOpen}
					onOpenChange={onModelSelectorOpenChange}
					models={models}
					groupedModels={groupedModels}
					modelId={modelId}
					selectedModelName={selectedModelName}
					favoriteIds={favoriteIds}
					warming={warming}
					onPickModel={onPickModel}
					onToggleFavorite={onToggleFavorite}
					effortOptions={effortOptions}
					reasoningEffort={reasoningEffort}
					onReasoningEffortChange={onReasoningEffortChange}
				/>
				<ComposerCollaborationSelector
					options={collaborationOptions}
					value={collaborationModeId}
					selectedName={selectedCollaborationName}
					onPick={onPickCollaborationMode}
				/>
				<ComposerFastToggle
					fastAvailable={fastAvailable}
					fastEnabled={fastEnabled}
					onToggle={onFastEnabledToggle}
				/>
			</div>
		</div>
	);
}
