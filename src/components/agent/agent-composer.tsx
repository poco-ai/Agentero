import { ImageIcon } from "lucide-react";
import type { KeyboardEvent, DragEvent as ReactDragEvent } from "react";
import { useTranslation } from "react-i18next";
import {
	ComposerImageAttachments,
	ComposerSubmitControl,
} from "@/components/agent/composer/composer-attachments";
import {
	ComposerContextChips,
	ComposerSkillChips,
} from "@/components/agent/composer/composer-context-chips";
import { ComposerDropTarget } from "@/components/agent/composer/composer-drop-target";
import { ComposerMentionMenu } from "@/components/agent/composer/composer-mention-menu";
import { ComposerModelSelector } from "@/components/agent/composer/composer-model-selector";
import { ComposerQueue } from "@/components/agent/composer/composer-queue";
import {
	ComposerSkillMenu,
	ComposerSlashMenu,
} from "@/components/agent/composer/composer-quick-menus";
import { ComposerToolbar } from "@/components/agent/composer/composer-toolbar";
import type { GroupedModel } from "@/components/agent/hooks/use-agent-config";
import { useComposerFileDrag } from "@/components/agent/hooks/use-composer-file-drag";
import type { QueuedPrompt } from "@/components/agent/types";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputTextarea,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import type {
	AgentEffortChoice,
	AgentModeChoice,
	AgentModelChoice,
	AgentSkill,
	PromptImage,
} from "@/lib/agent";
import { SUGGESTION_KEYS, SUGGESTION_WORKFLOW } from "@/lib/agent/chat-state";
import {
	COMPOSER_IMAGE_ACCEPT,
	COMPOSER_IMAGE_MAX_BYTES,
	COMPOSER_IMAGE_MAX_FILES,
	fileUiPartsToPromptImages,
} from "@/lib/agent/prompt-image";
import type { SelectionContext } from "@/lib/agent/selection-store";
import type { AcpCommand } from "@/lib/agent/slash-commands";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";

export type AgentComposerProps = {
	autoFocus: boolean;
	heightPx?: number;
	compact?: boolean;
	linesLength: number;
	activeTabIsRunning: boolean;
	switching: boolean;
	submitting: boolean;
	composerText: string;
	onComposerTextChange: (text: string) => void;
	onSubmit: (text: string, images?: PromptImage[]) => Promise<void>;
	onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	onComposerDragOver: (e: ReactDragEvent) => void;
	onComposerDrop: (e: ReactDragEvent) => void;
	onDismissComposerMenu: () => void;
	messageQueue: QueuedPrompt[];
	onRemoveQueuedMessage: (id: string) => void;
	currentFilePath: string | null;
	currentFileLabel: string;
	mentionChipPaths: string[];
	selectionChips: SelectionContext[];
	onRemoveSelection: (id: string) => void;
	visualDrafts: PdfVisualDraft[];
	onRemoveVisualDraft: (id: string) => void;
	directoryPathSet: ReadonlySet<string>;
	paperPathSet: ReadonlySet<string>;
	labelForPath: (path: string) => string;
	onRemoveContextPath: (path: string) => void;
	selectedSkills: AgentSkill[];
	onRemoveSkill: (skillId: string) => void;
	showMentionMenu: boolean;
	mentionBrowseRoot: string | null;
	mentionOptions: string[];
	mentionActiveIndex: number;
	mentionCandidates: string[];
	onLeaveMentionFolder: () => void;
	onEnterMentionFolder: (path: string) => void;
	onAttachMention: (path: string) => void;
	onMentionActiveIndexChange: (index: number) => void;
	showSkillMenu: boolean;
	skillOptions: AgentSkill[];
	skillActiveIndex: number;
	onAttachSkill: (skill: AgentSkill) => void;
	onSkillActiveIndexChange: (index: number) => void;
	showSlashMenu: boolean;
	slashOptions: AcpCommand[];
	slashActiveIndex: number;
	onAttachSlashCommand: (command: AcpCommand) => void;
	onSlashActiveIndexChange: (index: number) => void;
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
	effortOptionsInDisplayOrder: AgentEffortChoice[];
	reasoningEffort: string | null;
	onReasoningEffortChange: (id: string) => void;
	formatEffort: (value: string) => string;
	activeUsage: { used: number; size: number } | null;
	fastAvailable: boolean;
	fastEnabled: boolean;
	onFastEnabledToggle: () => void;
	onCancelRun: () => void;
	onSendSuggestion: (label: string, workflow?: string) => void;
};

export function AgentComposer(props: AgentComposerProps) {
	const {
		autoFocus,
		heightPx,
		compact = false,
		linesLength,
		activeTabIsRunning,
		switching,
		submitting,
		composerText,
		onComposerTextChange,
		onSubmit,
		onComposerKeyDown,
		onComposerDragOver,
		onComposerDrop,
		onDismissComposerMenu,
		visualDrafts,
		showMentionMenu,
		showSkillMenu,
		showSlashMenu,
		mentionActiveIndex,
		skillActiveIndex,
		slashActiveIndex,
		onCancelRun,
		onSendSuggestion,
	} = props;
	const { t } = useTranslation("agent");
	const hasComposerText = Boolean(composerText.trim());
	const hasVisualDrafts = visualDrafts.length > 0;
	// Attachments live inside PromptInput; base gate ignores them (see ComposerSubmitControl).
	const canSubmitBase = hasComposerText || hasVisualDrafts;
	const composerMenuOpen = showMentionMenu || showSkillMenu || showSlashMenu;
	const {
		shellRef,
		isFileDragOver,
		onFileDragEnter,
		onFileDragLeave,
		onFileDragOver,
		onFileDropHighlightEnd,
	} = useComposerFileDrag();

	return (
		<div
			className={cn(
				// Only the prompt shell is height-bound (resize handle is above this in the panel).
				"flex shrink-0 flex-col overflow-hidden border-t bg-muted/10",
				compact ? "gap-1.5 p-2" : "gap-2 p-3",
			)}
			style={heightPx ? { height: heightPx } : undefined}
		>
			{linesLength > 0 && !activeTabIsRunning && !compact ? (
				<Suggestions>
					{SUGGESTION_KEYS.map((key) => {
						const label = t(`suggestions.${key}`);
						return (
							<Suggestion
								key={key}
								suggestion={label}
								onClick={(v) => onSendSuggestion(v, SUGGESTION_WORKFLOW[key])}
								disabled={activeTabIsRunning || switching}
							/>
						);
					})}
				</Suggestions>
			) : null}
			<ComposerQueue
				messageQueue={props.messageQueue}
				onRemoveQueuedMessage={props.onRemoveQueuedMessage}
			/>
			<div
				ref={shellRef}
				data-composer-drop-shell
				className="relative min-h-0 flex-1"
			>
				<PromptInput
					className={cn(
						"h-full w-full rounded-xl border-border bg-background shadow-none transition-[background-color,box-shadow,border-color] duration-150",
						isFileDragOver &&
							"border-primary/55 bg-primary/5 shadow-[inset_0_0_0_1px] shadow-primary/25 ring-2 ring-primary/35",
					)}
					inputGroupClassName={cn(
						"!flex !h-full min-h-0 !flex-col overflow-hidden",
						// Keep the same surface while any child is disabled or a run is
						// in progress — never dim / recolor the composer for "processing".
						"has-disabled:bg-transparent has-disabled:opacity-100 dark:has-disabled:bg-input/30",
						isFileDragOver && "bg-transparent dark:bg-transparent",
					)}
					accept={COMPOSER_IMAGE_ACCEPT}
					multiple
					maxFiles={COMPOSER_IMAGE_MAX_FILES}
					maxFileSize={COMPOSER_IMAGE_MAX_BYTES}
					onError={(err) => {
						if (err.code === "accept") {
							notifyError(t("composer.imageAcceptError"));
							return;
						}
						notifyError(err.message);
					}}
					onDragEnter={onFileDragEnter}
					onDragLeave={onFileDragLeave}
					onDragOver={onFileDragOver}
					onDrop={onFileDropHighlightEnd}
					onSubmit={async ({ text, files }) => {
						const images = fileUiPartsToPromptImages(files);
						await onSubmit(text, images.length ? images : undefined);
					}}
				>
					<PromptInputBody>
						<Popover
							open={composerMenuOpen}
							modal={false}
							onOpenChange={(open) => {
								if (!open) onDismissComposerMenu();
							}}
						>
							<PopoverAnchor asChild>
								<ComposerDropTarget
									className={cn(
										"relative flex min-h-0 w-full flex-1 overflow-hidden",
										compact
											? "flex-row items-start gap-1 px-2 pt-2"
											: "flex-col px-3 pt-3",
									)}
									onVaultPathDragOver={onComposerDragOver}
									onVaultPathDrop={onComposerDrop}
								>
									<ComposerImageAttachments compact={compact} />
									<ComposerContextChips
										compact={compact}
										currentFilePath={props.currentFilePath}
										currentFileLabel={props.currentFileLabel}
										mentionChipPaths={props.mentionChipPaths}
										selectionChips={props.selectionChips}
										onRemoveSelection={props.onRemoveSelection}
										visualDrafts={visualDrafts}
										onRemoveVisualDraft={props.onRemoveVisualDraft}
										directoryPathSet={props.directoryPathSet}
										paperPathSet={props.paperPathSet}
										labelForPath={props.labelForPath}
										onRemoveContextPath={props.onRemoveContextPath}
									/>
									<ComposerSkillChips
										compact={compact}
										selectedSkills={props.selectedSkills}
										onRemoveSkill={props.onRemoveSkill}
									/>
									{/* The three menus stay in this Popover subtree on purpose — PopoverContent needs its context. */}
									{showMentionMenu ? (
										<ComposerMentionMenu
											mentionBrowseRoot={props.mentionBrowseRoot}
											mentionOptions={props.mentionOptions}
											mentionActiveIndex={mentionActiveIndex}
											mentionCandidates={props.mentionCandidates}
											directoryPathSet={props.directoryPathSet}
											paperPathSet={props.paperPathSet}
											labelForPath={props.labelForPath}
											onLeaveMentionFolder={props.onLeaveMentionFolder}
											onEnterMentionFolder={props.onEnterMentionFolder}
											onAttachMention={props.onAttachMention}
											onMentionActiveIndexChange={
												props.onMentionActiveIndexChange
											}
										/>
									) : null}
									{showSkillMenu ? (
										<ComposerSkillMenu
											skillOptions={props.skillOptions}
											skillActiveIndex={skillActiveIndex}
											onAttachSkill={props.onAttachSkill}
											onSkillActiveIndexChange={props.onSkillActiveIndexChange}
										/>
									) : null}
									{showSlashMenu ? (
										<ComposerSlashMenu
											slashOptions={props.slashOptions}
											slashActiveIndex={slashActiveIndex}
											onAttachSlashCommand={props.onAttachSlashCommand}
											onSlashActiveIndexChange={props.onSlashActiveIndexChange}
										/>
									) : null}
									<PromptInputTextarea
										autoFocus={autoFocus || undefined}
										className={cn(
											"agentero-scroll min-h-0 flex-1 overflow-y-auto px-0 py-1 placeholder:text-muted-foreground/80",
											compact
												? "max-h-none min-w-0 text-sm leading-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
												: "text-[15px] leading-6",
										)}
										value={composerText}
										onChange={(event) => {
											onComposerTextChange(event.currentTarget.value);
										}}
										onKeyDown={onComposerKeyDown}
										aria-expanded={
											showMentionMenu || showSkillMenu || showSlashMenu
										}
										aria-autocomplete="list"
										aria-controls={
											showMentionMenu
												? "agent-mention-menu"
												: showSkillMenu
													? "agent-skill-menu"
													: showSlashMenu
														? "agent-slash-menu"
														: undefined
										}
										aria-activedescendant={
											showMentionMenu
												? `agent-mention-option-${mentionActiveIndex}`
												: showSkillMenu
													? `agent-skill-option-${skillActiveIndex}`
													: showSlashMenu
														? `agent-slash-option-${slashActiveIndex}`
														: undefined
										}
										role="combobox"
										disabled={switching}
										placeholder={
											activeTabIsRunning
												? t("composer.queueHint")
												: t("composer.placeholder")
										}
									/>
								</ComposerDropTarget>
							</PopoverAnchor>
						</Popover>
					</PromptInputBody>
					<PromptInputFooter
						className={cn(
							"flex-wrap items-end gap-x-2 gap-y-1.5",
							compact ? "px-2 pb-2" : "px-3 pb-2.5",
						)}
					>
						<PromptInputTools
							className={cn(
								"min-w-0 flex-1 flex-wrap gap-1",
								compact && "flex-none",
							)}
						>
							{compact ? null : (
								<ComposerModelSelector
									open={props.modelSelectorOpen}
									onOpenChange={props.onModelSelectorOpenChange}
									models={props.models}
									groupedModels={props.groupedModels}
									modelId={props.modelId}
									selectedModelName={props.selectedModelName}
									favoriteIds={props.favoriteIds}
									warming={props.warming}
									onPickModel={props.onPickModel}
									onToggleFavorite={props.onToggleFavorite}
								/>
							)}
							<ComposerToolbar
								compact={compact}
								switching={switching}
								collaborationOptions={props.collaborationOptions}
								collaborationModeId={props.collaborationModeId}
								selectedCollaborationName={props.selectedCollaborationName}
								onPickCollaborationMode={props.onPickCollaborationMode}
								effortOptionsInDisplayOrder={props.effortOptionsInDisplayOrder}
								reasoningEffort={props.reasoningEffort}
								onReasoningEffortChange={props.onReasoningEffortChange}
								formatEffort={props.formatEffort}
								activeUsage={props.activeUsage}
								fastAvailable={props.fastAvailable}
								fastEnabled={props.fastEnabled}
								onFastEnabledToggle={props.onFastEnabledToggle}
							/>
						</PromptInputTools>
						<ComposerSubmitControl
							canSubmitBase={canSubmitBase}
							switching={switching}
							submitting={submitting}
							activeTabIsRunning={activeTabIsRunning}
							compact={compact}
							onCancelRun={onCancelRun}
						/>
					</PromptInputFooter>
				</PromptInput>
				{isFileDragOver ? (
					<div
						className={cn(
							"pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl",
							"border-2 border-primary/50 border-dashed bg-primary/10 backdrop-blur-[1px]",
						)}
						aria-hidden
					>
						<div className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/90 px-3 py-1.5 text-primary text-xs font-medium shadow-sm">
							<ImageIcon className="size-3.5 shrink-0" />
							<span>{t("composer.dropImageHint")}</span>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
