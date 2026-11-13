import type {
	KeyboardEvent as ReactKeyboardEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AgentAskUserSurface,
	isAskUserSurfaceActive,
} from "@/components/agent/agent-ask-user-surface";
import { AgentComposer } from "@/components/agent/agent-composer";
import { AgentConfigBar } from "@/components/agent/agent-config-bar";
import { SidebarHistoryTrailing } from "@/components/agent/agent-history";
import { AgentPermissionDialog } from "@/components/agent/agent-permission-dialog";
import { AgentSwitcher } from "@/components/agent/agent-switcher";
import { ChatTranscript } from "@/components/agent/chat-transcript";
import { PiProjectTrustNotice } from "@/components/agent/pi-project-trust-notice";
import type { AgentPanelProps } from "@/components/agent/types";
import { useAgentPanel } from "@/components/agent/use-agent-panel";
import { PaneHeader } from "@/components/shell/pane-header";
import { cn } from "@/lib/core/utils";

const COMPOSER_DEFAULT_HEIGHT_PX = 208;
const COMPOSER_MIN_HEIGHT_PX = 88;
const COMPOSER_MAX_HEIGHT_PX = 360;
const COMPOSER_COMPACT_THRESHOLD_PX = 160;
/** Below this app window height, prefer compact as the starting composer size. */
const WINDOW_COMPACT_THRESHOLD_PX = 600;
const TRANSCRIPT_MIN_HEIGHT_PX = 160;

// PERF: memoized at the usage site (definition file shared) — every prop is a
// primitive, stable state, or an identity-stable handler, so the config bar
// bails out on unrelated panel re-renders (streaming phase flips, typing).
const AgentConfigBarMemo = memo(AgentConfigBar);

function initialComposerHeightPx(): number {
	if (typeof window === "undefined") return COMPOSER_DEFAULT_HEIGHT_PX;
	return window.innerHeight < WINDOW_COMPACT_THRESHOLD_PX
		? COMPOSER_COMPACT_THRESHOLD_PX
		: COMPOSER_DEFAULT_HEIGHT_PX;
}

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
	initialAgentId = null,
	onAgentChange,
	openHistoryItem = null,
	onOpenHistoryHandled,
	restoringHistory = false,
	wide = false,
}: AgentPanelProps) {
	const { t } = useTranslation("agent");
	const panel = useAgentPanel({
		vaultPath,
		selectedPath,
		selectedPaperTitle,
		vaultMarkdownPaths,
		vaultDirectoryPaths,
		vaultPaperPaths,
		paperMetaByRelPath,
		paperTreeLabelMode,
		initialAgentId,
		onAgentChange,
		openHistoryItem,
		onOpenHistoryHandled,
	});
	const bodyRef = useRef<HTMLDivElement>(null);
	const [composerHeightPx, setComposerHeightPx] = useState(
		initialComposerHeightPx,
	);
	// Track short-window edge so we only auto-collapse once when crossing below
	// the threshold — never lock the user out of dragging back to expanded.
	const windowWasShortRef = useRef(
		typeof window !== "undefined" &&
			window.innerHeight < WINDOW_COMPACT_THRESHOLD_PX,
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
		const handleResize = () => {
			const short = window.innerHeight < WINDOW_COMPACT_THRESHOLD_PX;
			const crossedIntoShort = short && !windowWasShortRef.current;
			windowWasShortRef.current = short;
			setComposerHeightPx((height) => {
				const next = crossedIntoShort
					? Math.min(height, COMPOSER_COMPACT_THRESHOLD_PX)
					: height;
				return clampComposerHeight(next);
			});
		};
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
	// Compact is driven only by composer height so the resize handle can always
	// leave or re-enter compact, even when the app window is short.
	const composerCompact = composerHeightPx <= COMPOSER_COMPACT_THRESHOLD_PX;
	// Compact mode hugs content (no fixed height) so the shell does not leave a
	// empty band under the single-line input. Non-compact keeps the resize budget.
	const composerDisplayHeightPx = composerCompact
		? undefined
		: composerHeightPx;

	const {
		selectedPaperMeta,
		activeTabId,
		hydratingSessionId,
		selected,
		activeTabIsRunning,
		activePhase,
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
		openSelectedAgentLogin,
		selectedLogin,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		historyOpen,
		setHistoryOpen,
		newConversation,
		openHistorySession,
		removeHistorySession,
		options,
		selectedAgentId,
		hasRunningSessions,
		selectAgent,
		composerText,
		onComposerTextChangeFromUser,
		composerInputRef,
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setSkillActiveIndex,
		handleComposerMenuKeyDown,
		handleComposerDragOver,
		handleComposerDrop,
		currentFilePath,
		currentFileLabel,
		mentionChipPaths,
		visualDrafts,
		removeVisualDraft,
		directoryPathSet,
		paperPathSet,
		labelForPath,
		removeContextPath,
		selectedSkills,
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
		removeSkill,
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
		effortOptions,
		reasoningEffort,
		pickReasoningEffort,
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
		recordAskUserAnswers,
		switchingRef,
		submittingRef,
	} = panel;

	// Questionnaire and free-text composer are mutually exclusive.
	const askUserActive = isAskUserSurfaceActive({
		elicitationRequest,
		askUserRequest,
		toolAskUserRequest,
	});

	// PERF: latest-ref wrappers keep memoized children (ChatTranscript,
	// AgentConfigBar) props identity-stable — the sub-hooks return plain
	// functions whose identity changes every render. Wrappers always call
	// the freshest handler, so stability never means stale closures.
	const latestTranscriptHandlersRef = useRef({
		submitComposer,
		cancelEditingMessage,
		resendEditedMessage,
		startEditingMessage,
	});
	latestTranscriptHandlersRef.current = {
		submitComposer,
		cancelEditingMessage,
		resendEditedMessage,
		startEditingMessage,
	};
	const sendSuggestion = useCallback((label: string, workflow?: string) => {
		void latestTranscriptHandlersRef.current.submitComposer(label, workflow);
	}, []);
	const handleCancelEditing = useCallback(
		() => latestTranscriptHandlersRef.current.cancelEditingMessage(),
		[],
	);
	const handleResendEdited = useCallback((lineId: string) => {
		void latestTranscriptHandlersRef.current.resendEditedMessage(lineId);
	}, []);
	const handleStartEditing = useCallback(
		(lineId: string, text: string) =>
			latestTranscriptHandlersRef.current.startEditingMessage(lineId, text),
		[],
	);
	// editCompositionProps is a fresh object literal per render while its
	// callbacks are useCallback-stable — rewrap so memo shallow-equality holds.
	const { onCompositionStart, onCompositionEnd } = editCompositionProps;
	const stableEditCompositionProps = useMemo(
		() => ({ onCompositionStart, onCompositionEnd }),
		[onCompositionStart, onCompositionEnd],
	);

	const latestPickModelRef = useRef(pickModel);
	latestPickModelRef.current = pickModel;
	const handlePickModel = useCallback(
		(id: string) => latestPickModelRef.current(id),
		[],
	);
	const toggleFastEnabled = useCallback(
		() => setFastEnabled((current) => !current),
		[setFastEnabled],
	);

	return (
		<section
			data-agent-panel
			className={cn(
				"flex h-full min-h-0 select-none flex-col bg-sidebar",
				className,
			)}
			aria-label={title}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<PaneHeader
					trailing={
						<SidebarHistoryTrailing
							historyOpen={historyOpen}
							onHistoryOpenChange={setHistoryOpen}
							activeTabId={activeTabId}
							submitting={submitting}
							headerActions={headerActions}
							onNewConversation={newConversation}
							onOpenSession={openHistorySession}
							onDeleteSession={removeHistorySession}
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

				<AgentConfigBarMemo
					modelSelectorOpen={modelSelectorOpen}
					onModelSelectorOpenChange={setModelSelectorOpen}
					models={models}
					groupedModels={groupedModels}
					modelId={modelId}
					selectedModelName={selectedModelName}
					favoriteIds={favoriteIds}
					warming={warming}
					onPickModel={handlePickModel}
					onToggleFavorite={toggleFavorite}
					collaborationOptions={collaborationOptions}
					collaborationModeId={collaborationModeId}
					selectedCollaborationName={selectedCollaborationName}
					onPickCollaborationMode={pickCollaborationMode}
					effortOptions={effortOptions}
					reasoningEffort={reasoningEffort}
					onReasoningEffortChange={pickReasoningEffort}
					fastAvailable={fastAvailable}
					fastEnabled={fastEnabled}
					onFastEnabledToggle={toggleFastEnabled}
				/>

				<div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
					<ChatTranscript
						wide={wide}
						activeTabId={activeTabId}
						hydratingSessionId={hydratingSessionId}
						restoring={restoringHistory}
						compact={composerCompact}
						activeTabIsRunning={activeTabIsRunning}
						phase={activePhase}
						submitting={submitting}
						switching={switching}
						editingLineId={editingLineId}
						editingText={editingText}
						editTextareaRef={editTextareaRef}
						editCompositionProps={stableEditCompositionProps}
						isEditBlockedByIme={isEditBlockedByIme}
						onEditingTextChange={setEditingText}
						onCancelEditing={handleCancelEditing}
						onResendEdited={handleResendEdited}
						onStartEditing={handleStartEditing}
						onSendSuggestion={sendSuggestion}
						onAgentLogin={selectedLogin ? openSelectedAgentLogin : undefined}
						onOpenSource={onOpenSource}
						agentTemplate={selected?.template ?? null}
						paper={selectedPaperMeta}
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
						onRecordAskUserAnswers={recordAskUserAnswers}
						disabled={switching}
					/>

					{!askUserActive ? (
						<>
							<PiProjectTrustNotice
								vaultPath={vaultPath}
								agentId={selected?.id}
								template={selected?.template}
								disabled={hasRunningSessions}
							/>
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
								wide={wide}
								autoFocus={autoFocus}
								heightPx={composerDisplayHeightPx}
								compact={composerCompact}
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
								visualDrafts={visualDrafts}
								onRemoveVisualDraft={removeVisualDraft}
								directoryPathSet={directoryPathSet}
								paperPathSet={paperPathSet}
								labelForPath={labelForPath}
								onRemoveContextPath={removeContextPath}
								selectedSkills={selectedSkills}
								onRemoveSkill={removeSkill}
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
								activeUsage={activeUsage}
								composerInputRef={composerInputRef}
								onCancelRun={() => void cancelCurrentRun()}
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
