import type {
	KeyboardEvent as ReactKeyboardEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	AgentAskUserSurface,
	isAskUserSurfaceActive,
} from "@/components/agent/agent-ask-user-surface";
import { AgentComposer } from "@/components/agent/agent-composer";
import { SidebarHistoryTrailing } from "@/components/agent/agent-history";
import { AgentPermissionDialog } from "@/components/agent/agent-permission-dialog";
import { AgentSwitcher } from "@/components/agent/agent-switcher";
import { ChatTranscript } from "@/components/agent/chat-transcript";
import type { AgentPanelProps } from "@/components/agent/types";
import { useAgentPanel } from "@/components/agent/use-agent-panel";
import { PaneHeader } from "@/components/shell/pane-header";
import { removeSelection } from "@/lib/agent/selection-store";
import { cn } from "@/lib/core/utils";

const COMPOSER_DEFAULT_HEIGHT_PX = 208;
const COMPOSER_MIN_HEIGHT_PX = 88;
const COMPOSER_MAX_HEIGHT_PX = 360;
const COMPOSER_COMPACT_THRESHOLD_PX = 140;
const TRANSCRIPT_MIN_HEIGHT_PX = 160;

export type { AgentPanelProps } from "@/components/agent/types";

export const AgentPanel = memo(function AgentPanel({
	vaultPath,
	selectedPath = null,
	selectedPaperTitle = null,
	vaultMarkdownPaths = [],
	vaultDirectoryPaths = [],
	vaultPaperPaths = [],
	paperMetaByRelPath = null,
	paperTreeLabelMode = "title-author",
	className,
	headerActions,
	autoFocus = false,
	title = "Chat",
	onOpenAgentSettings,
	onOpenSource,
}: AgentPanelProps) {
	const panel = useAgentPanel({
		vaultPath,
		selectedPath,
		selectedPaperTitle,
		vaultMarkdownPaths,
		vaultDirectoryPaths,
		vaultPaperPaths,
		paperMetaByRelPath,
		paperTreeLabelMode,
	});
	const bodyRef = useRef<HTMLDivElement>(null);
	const [composerHeightPx, setComposerHeightPx] = useState(
		COMPOSER_DEFAULT_HEIGHT_PX,
	);

	const clampComposerHeight = useCallback((height: number) => {
		const bodyHeight = bodyRef.current?.getBoundingClientRect().height ?? 0;
		const availableMax =
			bodyHeight > 0
				? Math.max(
						COMPOSER_MIN_HEIGHT_PX,
						Math.min(
							COMPOSER_MAX_HEIGHT_PX,
							bodyHeight - TRANSCRIPT_MIN_HEIGHT_PX,
						),
					)
				: COMPOSER_MAX_HEIGHT_PX;
		return Math.min(Math.max(height, COMPOSER_MIN_HEIGHT_PX), availableMax);
	}, []);

	useEffect(() => {
		const handleResize = () =>
			setComposerHeightPx((height) => clampComposerHeight(height));
		handleResize();
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [clampComposerHeight]);

	const onComposerResizePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const startY = event.clientY;
			const startHeight = composerHeightPx;

			const handlePointerMove = (moveEvent: PointerEvent) => {
				const deltaY = startY - moveEvent.clientY;
				setComposerHeightPx(clampComposerHeight(startHeight + deltaY));
			};
			const handlePointerUp = () => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerUp);
			};

			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", handlePointerUp, { once: true });
		},
		[clampComposerHeight, composerHeightPx],
	);
	const onComposerResizeKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLButtonElement>) => {
			const smallStep = event.shiftKey ? 32 : 16;
			const largeStep = 64;
			switch (event.key) {
				case "ArrowUp":
					event.preventDefault();
					setComposerHeightPx((height) =>
						clampComposerHeight(height + smallStep),
					);
					break;
				case "ArrowDown":
					event.preventDefault();
					setComposerHeightPx((height) =>
						clampComposerHeight(height - smallStep),
					);
					break;
				case "PageUp":
					event.preventDefault();
					setComposerHeightPx((height) =>
						clampComposerHeight(height + largeStep),
					);
					break;
				case "PageDown":
					event.preventDefault();
					setComposerHeightPx((height) =>
						clampComposerHeight(height - largeStep),
					);
					break;
				case "Home":
					event.preventDefault();
					setComposerHeightPx(clampComposerHeight(COMPOSER_MIN_HEIGHT_PX));
					break;
				case "End":
					event.preventDefault();
					setComposerHeightPx(clampComposerHeight(COMPOSER_MAX_HEIGHT_PX));
					break;
			}
		},
		[clampComposerHeight],
	);
	const composerCompact = composerHeightPx <= COMPOSER_COMPACT_THRESHOLD_PX;

	const {
		t,
		lines,
		activeTabId,
		selected,
		activeTabIsRunning,
		submitting,
		switching,
		editingLineId,
		editingText,
		editTextareaRef,
		editCompositionProps,
		isEditBlockedByIme,
		setEditingText,
		cancelEditingMessage,
		resendEditedMessage,
		startEditingMessage,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		sessionHistory,
		historyOpen,
		setHistoryOpen,
		newConversation,
		openHistorySession,
		options,
		selectedAgentId,
		hasRunningSessions,
		selectAgent,
		composerText,
		onComposerTextChangeFromUser,
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setSkillActiveIndex,
		handleComposerMenuKeyDown,
		handleComposerDragOver,
		handleComposerDrop,
		currentFilePath,
		currentFileLabel,
		mentionChipPaths,
		selectionChips,
		visualDrafts,
		removeVisualDraft,
		directoryPathSet,
		paperPathSet,
		labelForPath,
		removeContextPath,
		selectedSkills,
		setSelectedSkillIds,
		showMentionMenu,
		mentionBrowseRoot,
		mentionOptions,
		mentionActiveIndex,
		mentionCandidates,
		leaveMentionFolder,
		enterMentionFolder,
		attachMention,
		showSkillMenu,
		skillOptions,
		skillActiveIndex,
		attachSkill,
		showSlashMenu,
		slashOptions,
		slashActiveIndex,
		setSlashActiveIndex,
		attachSlashCommand,
		modelSelectorOpen,
		setModelSelectorOpen,
		models,
		groupedModels,
		modelId,
		selectedModelName,
		favoriteIds,
		warming,
		pickModel,
		toggleFavorite,
		collaborationOptions,
		collaborationModeId,
		selectedCollaborationName,
		pickCollaborationMode,
		effortOptionsInDisplayOrder,
		reasoningEffort,
		setReasoningEffort,
		formatEffort,
		activeUsage,
		fastAvailable,
		fastEnabled,
		setFastEnabled,
		cancelCurrentRun,
		permissionRequest,
		setPermissionRequest,
		elicitationRequest,
		setElicitationRequest,
		askUserRequest,
		setAskUserRequest,
		toolAskUserRequest,
		setToolAskUserRequest,
		answerToolAskUser,
		switchingRef,
		submittingRef,
	} = panel;

	// Questionnaire and free-text composer are mutually exclusive.
	const askUserActive = isAskUserSurfaceActive({
		elicitationRequest,
		askUserRequest,
		toolAskUserRequest,
	});

	const sendSuggestion = (label: string, workflow?: string) => {
		void submitComposer(label, workflow);
	};

	return (
		<section
			data-agent-panel
			className={cn("flex h-full min-h-0 flex-col bg-background", className)}
			aria-label={title}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<PaneHeader
					trailing={
						<SidebarHistoryTrailing
							historyOpen={historyOpen}
							onHistoryOpenChange={setHistoryOpen}
							sessionHistory={sessionHistory}
							activeTabId={activeTabId}
							submitting={submitting}
							headerActions={headerActions}
							onNewConversation={newConversation}
							onOpenSession={openHistorySession}
						/>
					}
				>
					<AgentSwitcher
						options={options}
						selected={selected}
						selectedAgentId={selectedAgentId}
						disabled={hasRunningSessions || switching || submitting}
						onSelect={(opt) => void selectAgent(opt)}
						onOpenAgentSettings={onOpenAgentSettings}
					/>
				</PaneHeader>

				<div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
					<ChatTranscript
						lines={lines}
						activeTabId={activeTabId}
						agentName={selected?.name ?? t("defaultName")}
						compact={composerCompact}
						activeTabIsRunning={activeTabIsRunning}
						submitting={submitting}
						switching={switching}
						editingLineId={editingLineId}
						editingText={editingText}
						editTextareaRef={editTextareaRef}
						editCompositionProps={editCompositionProps}
						isEditBlockedByIme={isEditBlockedByIme}
						onEditingTextChange={setEditingText}
						onCancelEditing={cancelEditingMessage}
						onResendEdited={(lineId) => void resendEditedMessage(lineId)}
						onStartEditing={startEditingMessage}
						onSendSuggestion={sendSuggestion}
						onOpenSource={onOpenSource}
					/>

					{/* Questionnaire replaces the composer until submit/cancel. */}
					<AgentAskUserSurface
						elicitationRequest={elicitationRequest}
						onElicitationResolved={() => setElicitationRequest(null)}
						askUserRequest={askUserRequest}
						onAskUserResolved={() => setAskUserRequest(null)}
						toolAskUserRequest={toolAskUserRequest}
						onToolAskUserResolved={() => setToolAskUserRequest(null)}
						onAnswerToolAskUser={answerToolAskUser}
						disabled={switching}
					/>

					{!askUserActive ? (
						<>
							<button
								type="button"
								aria-label={t("composer.resizeHandle")}
								title={t("composer.resizeHandle")}
								className="group relative h-2 shrink-0 cursor-row-resize touch-none bg-muted/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								onPointerDown={onComposerResizePointerDown}
								onKeyDown={onComposerResizeKeyDown}
							>
								<div className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 h-px w-12 rounded-full bg-border transition-colors group-hover:bg-foreground/35 group-active:bg-foreground/45" />
							</button>

							<AgentComposer
								autoFocus={autoFocus}
								heightPx={composerHeightPx}
								compact={composerCompact}
								linesLength={lines.length}
								activeTabIsRunning={activeTabIsRunning}
								switching={switching}
								submitting={submitting}
								composerText={composerText}
								onComposerTextChange={(text) => {
									onComposerTextChangeFromUser(text);
									setComposerMenuDismissed(false);
									setMentionActiveIndex(0);
									setSkillActiveIndex(0);
									setSlashActiveIndex(0);
								}}
								onSubmit={async (text, images) => {
									if (switchingRef.current || submittingRef.current) {
										// Keep PromptInput attachments when the submit is rejected.
										throw new Error("composer busy");
									}
									const ok = await submitComposer(text, undefined, images);
									if (!ok) {
										// Preserve pasted/picked images when send early-returns (e.g. no agent).
										throw new Error("composer submit rejected");
									}
								}}
								onComposerKeyDown={handleComposerMenuKeyDown}
								onComposerDragOver={handleComposerDragOver}
								onComposerDrop={handleComposerDrop}
								onDismissComposerMenu={() => setComposerMenuDismissed(true)}
								messageQueue={messageQueue}
								onRemoveQueuedMessage={removeQueuedMessage}
								currentFilePath={currentFilePath}
								currentFileLabel={currentFileLabel}
								mentionChipPaths={mentionChipPaths}
								selectionChips={selectionChips}
								onRemoveSelection={removeSelection}
								visualDrafts={visualDrafts}
								onRemoveVisualDraft={removeVisualDraft}
								directoryPathSet={directoryPathSet}
								paperPathSet={paperPathSet}
								labelForPath={labelForPath}
								onRemoveContextPath={removeContextPath}
								selectedSkills={selectedSkills}
								onRemoveSkill={(skillId) =>
									setSelectedSkillIds((prev) =>
										prev.filter((id) => id !== skillId),
									)
								}
								showMentionMenu={showMentionMenu}
								mentionBrowseRoot={mentionBrowseRoot}
								mentionOptions={mentionOptions}
								mentionActiveIndex={mentionActiveIndex}
								mentionCandidates={mentionCandidates}
								onLeaveMentionFolder={leaveMentionFolder}
								onEnterMentionFolder={enterMentionFolder}
								onAttachMention={attachMention}
								onMentionActiveIndexChange={setMentionActiveIndex}
								showSkillMenu={showSkillMenu}
								skillOptions={skillOptions}
								skillActiveIndex={skillActiveIndex}
								onAttachSkill={attachSkill}
								onSkillActiveIndexChange={setSkillActiveIndex}
								showSlashMenu={showSlashMenu}
								slashOptions={slashOptions}
								slashActiveIndex={slashActiveIndex}
								onAttachSlashCommand={attachSlashCommand}
								onSlashActiveIndexChange={setSlashActiveIndex}
								modelSelectorOpen={modelSelectorOpen}
								onModelSelectorOpenChange={setModelSelectorOpen}
								models={models}
								groupedModels={groupedModels}
								modelId={modelId}
								selectedModelName={selectedModelName}
								favoriteIds={favoriteIds}
								warming={warming}
								onPickModel={pickModel}
								onToggleFavorite={toggleFavorite}
								collaborationOptions={collaborationOptions}
								collaborationModeId={collaborationModeId}
								selectedCollaborationName={selectedCollaborationName}
								onPickCollaborationMode={pickCollaborationMode}
								effortOptionsInDisplayOrder={effortOptionsInDisplayOrder}
								reasoningEffort={reasoningEffort}
								onReasoningEffortChange={setReasoningEffort}
								formatEffort={formatEffort}
								activeUsage={activeUsage}
								fastAvailable={fastAvailable}
								fastEnabled={fastEnabled}
								onFastEnabledToggle={() =>
									setFastEnabled((current) => !current)
								}
								onCancelRun={() => void cancelCurrentRun()}
								onSendSuggestion={sendSuggestion}
							/>
						</>
					) : null}
				</div>
			</div>

			<AgentPermissionDialog
				permissionRequest={permissionRequest}
				onDismiss={() => setPermissionRequest(null)}
			/>
		</section>
	);
});
