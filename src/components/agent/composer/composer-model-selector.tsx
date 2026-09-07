import { ChevronDown, LoaderCircle, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ComposerReasoningEffort } from "@/components/agent/composer/composer-reasoning-effort";
import type { GroupedModel } from "@/components/agent/hooks/use-agent-config";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentEffortChoice, AgentModelChoice } from "@/lib/agent";
import { cn } from "@/lib/core/utils";

export function ComposerModelSelector({
	open,
	onOpenChange,
	models,
	groupedModels,
	modelId,
	selectedModelName,
	favoriteIds,
	warming,
	onPickModel,
	onToggleFavorite,
	effortOptions,
	reasoningEffort,
	onReasoningEffortChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	models: AgentModelChoice[];
	groupedModels: GroupedModel[];
	modelId: string | null;
	selectedModelName: string | null;
	favoriteIds: string[];
	warming: boolean;
	onPickModel: (id: string) => void;
	onToggleFavorite: (id: string) => void;
	effortOptions: AgentEffortChoice[];
	reasoningEffort: string | null;
	onReasoningEffortChange: (id: string) => void;
}) {
	const { t } = useTranslation("agent");
	const searchRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLDivElement>(null);
	const [pendingLocate, setPendingLocate] = useState<string | null>(null);
	const [highlightedModelId, setHighlightedModelId] = useState<string | null>(
		null,
	);
	/** Controlled search so free-form / third-party model ids can be entered (#216). */
	const [modelQuery, setModelQuery] = useState("");
	const customModelId = modelQuery.trim();
	const canUseCustomModel =
		customModelId.length > 0 &&
		!models.some(
			(m) =>
				m.id === customModelId ||
				m.name.trim().toLowerCase() === customModelId.toLowerCase(),
		);

	const canLocate = Boolean(
		modelId &&
			groupedModels.some(
				(group) =>
					!group.isFavorites &&
					group.items.some((model) => model.id === modelId),
			),
	);

	useEffect(() => {
		if (!open || modelQuery || !pendingLocate) return;
		// Wait for cmdk to restore rows after clearing a filter.
		const frame = requestAnimationFrame(() => {
			selectedItemRef.current?.scrollIntoView({
				block: "center",
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
					? "instant"
					: "smooth",
			});
			setHighlightedModelId(pendingLocate);
			setPendingLocate(null);
		});
		return () => cancelAnimationFrame(frame);
	}, [open, modelQuery, pendingLocate]);

	useEffect(() => {
		if (!highlightedModelId) return;
		const timer = setTimeout(() => setHighlightedModelId(null), 1200);
		return () => clearTimeout(timer);
	}, [highlightedModelId]);

	return (
		<ModelSelector
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) {
					setModelQuery("");
					setPendingLocate(null);
					setHighlightedModelId(null);
				}
			}}
		>
			<ModelSelectorTrigger asChild>
				<PromptInputButton
					type="button"
					className="h-7 min-w-0 max-w-[min(16rem,100%)] shrink gap-1 px-1.5 text-xs font-medium text-foreground"
					disabled={warming}
					tooltip={{
						content:
							models.length > 0 || selectedModelName
								? t("models.selectTooltip")
								: t("models.customOrReportedTooltip"),
						side: "bottom",
					}}
				>
					<span className="min-w-0 flex-1 truncate text-xs">
						{selectedModelName ??
							(warming ? t("models.loading") : t("models.button"))}
					</span>
					<ChevronDown className="size-3 shrink-0 opacity-70" />
				</PromptInputButton>
			</ModelSelectorTrigger>
			<ModelSelectorContent
				className="sm:max-w-md"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					searchRef.current?.focus();
				}}
				header={
					modelId || selectedModelName ? (
						<div className="min-w-0 space-y-2 border-b px-3 py-3">
							<div className="pr-8 text-xs text-muted-foreground">
								{t("models.currentSelection")}
							</div>
							<div className="flex min-w-0 items-baseline gap-2">
								{canLocate ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												className="flex h-7 min-w-0 items-center rounded-sm text-left font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
												onClick={() => {
													setModelQuery("");
													setPendingLocate(modelId);
												}}
											>
												<span className="truncate">
													{selectedModelName ?? modelId}
												</span>
											</button>
										</TooltipTrigger>
										<TooltipContent>{t("models.locateCurrent")}</TooltipContent>
									</Tooltip>
								) : (
									<span
										className="min-w-0 truncate font-medium"
										title={selectedModelName ?? modelId ?? undefined}
									>
										{selectedModelName ?? modelId}
									</span>
								)}
								{effortOptions.length > 0 ? (
									<ComposerReasoningEffort
										options={effortOptions}
										value={reasoningEffort}
										disabled={warming}
										onChange={onReasoningEffortChange}
									/>
								) : null}
								{warming ? (
									<LoaderCircle
										className="size-3.5 shrink-0 self-center animate-spin motion-reduce:animate-none text-muted-foreground"
										aria-label={t("models.loading")}
									/>
								) : null}
							</div>
						</div>
					) : null
				}
			>
				<ModelSelectorInput
					ref={searchRef}
					value={modelQuery}
					onValueChange={setModelQuery}
					placeholder={t("models.searchOrCustomPlaceholder")}
				/>
				<ModelSelectorList className="max-h-[min(16rem,45dvh)]">
					{canUseCustomModel ? (
						<ModelSelectorGroup heading={t("models.customGroup")}>
							<ModelSelectorItem
								value={customModelId}
								disabled={warming}
								onSelect={() => onPickModel(customModelId)}
							>
								<span className="flex-1 truncate">
									{t("models.useCustom", { id: customModelId })}
								</span>
							</ModelSelectorItem>
						</ModelSelectorGroup>
					) : null}
					{groupedModels.map((group) => (
						<ModelSelectorGroup key={group.id} heading={group.heading}>
							{group.items.map((model) => {
								const favorited = favoriteIds.includes(model.id);
								const selected = modelId === model.id;
								return (
									<ModelSelectorItem
										key={`${group.id}-${model.id}`}
										ref={
											selected && !group.isFavorites
												? selectedItemRef
												: undefined
										}
										disabled={warming}
										data-checked={selected}
										value={`${model.name} ${model.id}${
											group.isFavorites ? "\u200b" : ""
										}`}
										onSelect={() => onPickModel(model.id)}
										className={cn(
											highlightedModelId === model.id &&
												!group.isFavorites &&
												"ring-2 ring-inset ring-primary/50",
											selected &&
												"bg-accent font-medium text-accent-foreground data-selected:bg-accent",
										)}
									>
										<span className="flex-1 truncate">{model.name}</span>
										<button
											type="button"
											aria-label={
												favorited
													? t("models.removeFromFavorites")
													: t("models.addToFavorites")
											}
											title={
												favorited
													? t("models.removeFromFavorites")
													: t("models.addToFavorites")
											}
											className={cn(
												"rounded p-0.5 text-muted-foreground transition hover:text-foreground",
												favorited
													? "opacity-100"
													: "opacity-0 group-hover/command-item:opacity-100 group-data-selected/command-item:opacity-100",
											)}
											onClick={(e) => {
												e.stopPropagation();
												e.preventDefault();
												onToggleFavorite(model.id);
											}}
											onPointerDown={(e) => e.stopPropagation()}
											onMouseDown={(e) => e.stopPropagation()}
										>
											<Star
												className={cn(
													"size-3.5",
													favorited && "fill-current text-amber-500",
												)}
											/>
										</button>
									</ModelSelectorItem>
								);
							})}
						</ModelSelectorGroup>
					))}
					<ModelSelectorEmpty>
						{canUseCustomModel
							? null
							: models.length === 0
								? t("models.emptyNoneCustom")
								: t("models.emptyNoMatch")}
					</ModelSelectorEmpty>
				</ModelSelectorList>
			</ModelSelectorContent>
		</ModelSelector>
	);
}
