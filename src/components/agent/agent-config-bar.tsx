import { CheckIcon, ChevronDown, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ComposerModelSelector } from "@/components/agent/composer/composer-model-selector";
import type { GroupedModel } from "@/components/agent/hooks/use-agent-config";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
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
				{collaborationOptions.length > 0 ? (
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<InputGroupButton
										type="button"
										variant="ghost"
										size="sm"
										className="h-7 min-w-0 max-w-[min(10rem,100%)] shrink gap-1 px-1.5 text-xs font-medium text-foreground"
									>
										<span className="min-w-0 flex-1 truncate">
											{t("composer.collaboration.label")}:{" "}
											{selectedCollaborationName ??
												collaborationModeId ??
												t("composer.collaboration.label")}
										</span>
										<ChevronDown className="size-3 shrink-0 opacity-70" />
									</InputGroupButton>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("composer.collaborationTooltip")}
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="start" className="min-w-36 p-1">
							{collaborationOptions.map((mode) => (
								<DropdownMenuItem
									key={mode.id}
									className={cn(
										"flex items-center justify-between gap-2 rounded-md",
										collaborationModeId === mode.id && "bg-muted",
									)}
									onSelect={() => onPickCollaborationMode(mode.id)}
								>
									<span className="min-w-0 flex-1 truncate">{mode.name}</span>
									{collaborationModeId === mode.id ? (
										<CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
									) : null}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
				{fastAvailable ? (
					<PromptInputButton
						type="button"
						className={cn(
							"size-7 text-foreground",
							fastEnabled && "text-amber-500 hover:text-amber-500",
						)}
						aria-pressed={fastEnabled}
						onClick={onFastEnabledToggle}
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
				) : null}
			</div>
		</div>
	);
}
