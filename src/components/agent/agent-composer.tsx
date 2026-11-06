import { ImageIcon } from "lucide-react";
import {
	type KeyboardEvent,
	type DragEvent as ReactDragEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	ComposerAnnotations,
	type SelectionHoverAnchor,
} from "@/components/agent/composer/composer-annotations";
import {
	ComposerImageAttachments,
	ComposerSubmitControl,
} from "@/components/agent/composer/composer-attachments";
import {
	ComposerContextChips,
	VisualReferenceCard,
} from "@/components/agent/composer/composer-context-chips";
import { ComposerDropTarget } from "@/components/agent/composer/composer-drop-target";
import type { ComposerInlineInputHandle } from "@/components/agent/composer/composer-inline-input";
import { ComposerInlineInput } from "@/components/agent/composer/composer-inline-input";
import { ComposerMentionMenu } from "@/components/agent/composer/composer-mention-menu";
import { ComposerQueue } from "@/components/agent/composer/composer-queue";
import {
	ComposerSkillMenu,
	ComposerSlashMenu,
} from "@/components/agent/composer/composer-quick-menus";
import { ComposerToolbar } from "@/components/agent/composer/composer-toolbar";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputTools,
} from "@/components/agent/composer/prompt-input";
import { useComposerFileDrag } from "@/components/agent/hooks/use-composer-file-drag";
import type { QueuedPrompt } from "@/components/agent/types";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import type { AgentSkill, PromptImage } from "@/lib/agent";
import { annotationOrdinal } from "@/lib/agent/annotation-prompt";
import { extractVisualIds } from "@/lib/agent/composer-inline-tokens";
import {
	COMPOSER_IMAGE_ACCEPT,
	COMPOSER_IMAGE_MAX_BYTES,
	COMPOSER_IMAGE_MAX_FILES,
	fileUiPartsToPromptImages,
} from "@/lib/agent/prompt-image";
import type { AcpCommand } from "@/lib/agent/slash-commands";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";

export type AgentComposerProps = {
	autoFocus: boolean;
	heightPx?: number;
	compact?: boolean;
	activeTabIsRunning: boolean;
	switching: boolean;
	submitting: boolean;
	composerText: string;
	onComposerTextChange: (text: string) => void;
	onSubmit: (text: string, images?: PromptImage[]) => Promise<void>;
	onComposerKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onComposerDragOver: (e: ReactDragEvent) => void;
	onComposerDrop: (e: ReactDragEvent) => void;
	onDismissComposerMenu: () => void;
	messageQueue: QueuedPrompt[];
	onRemoveQueuedMessage: (id: string) => void;
	currentFilePath: string | null;
	currentFileLabel: string;
	mentionChipPaths: string[];
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
	activeUsage: { used: number; size: number } | null;
	onCancelRun: () => void;
	composerInputRef: RefObject<ComposerInlineInputHandle | null>;
};

type ReferenceHover = {
	kind: "selection" | "visual";
	id: string;
	anchor: HTMLElement;
};

export function AgentComposer(props: AgentComposerProps) {
	const {
		autoFocus,
		heightPx,
		compact = false,
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
	} = props;
	const { t } = useTranslation("agent");
	const hasComposerText = Boolean(composerText.trim());
	const hasVisualDrafts = extractVisualIds(composerText).some((id) =>
		visualDrafts.some((draft) => draft.id === id),
	);
	// Attachments live inside PromptInput; base gate ignores them (see ComposerSubmitControl).
	const canSubmitBase = hasComposerText || hasVisualDrafts;
	const composerMenuOpen = showMentionMenu || showSkillMenu || showSlashMenu;
	const hasQueuedMessages = props.messageQueue.length > 0;
	const [referenceHover, setReferenceHover] = useState<ReferenceHover | null>(
		null,
	);
	const hoverOpenTimer = useRef<number | null>(null);
	const hoverCloseTimer = useRef<number | null>(null);
	const referenceHoverRef = useRef(referenceHover);
	referenceHoverRef.current = referenceHover;
	const pendingHoverRef = useRef<ReferenceHover | null>(null);
	const clearHoverTimers = useCallback(() => {
		if (hoverOpenTimer.current != null) {
			window.clearTimeout(hoverOpenTimer.current);
			hoverOpenTimer.current = null;
		}
		if (hoverCloseTimer.current != null) {
			window.clearTimeout(hoverCloseTimer.current);
			hoverCloseTimer.current = null;
		}
	}, []);
	const onReferencePointer = useCallback(
		(
			kind: ReferenceHover["kind"],
			phase: "enter" | "leave",
			id: string,
			anchor: HTMLElement,
		) => {
			if (phase === "enter") {
				if (hoverCloseTimer.current != null) {
					window.clearTimeout(hoverCloseTimer.current);
					hoverCloseTimer.current = null;
				}
				const next = { kind, id, anchor };
				pendingHoverRef.current = next;
				const current = referenceHoverRef.current;
				if (current?.kind === kind && current.id === id) {
					if (current.anchor !== anchor) setReferenceHover(next);
					return;
				}
				// A move between chips keeps the timer already running and opens
				// whichever reference the pointer settled on.
				if (hoverOpenTimer.current != null) return;
				hoverOpenTimer.current = window.setTimeout(() => {
					hoverOpenTimer.current = null;
					const pending = pendingHoverRef.current;
					if (pending) setReferenceHover(pending);
				}, 150);
				return;
			}
			const pending = pendingHoverRef.current;
			if (pending?.kind === kind && pending.id === id) {
				pendingHoverRef.current = null;
			}
			if (hoverOpenTimer.current != null && pendingHoverRef.current == null) {
				window.clearTimeout(hoverOpenTimer.current);
				hoverOpenTimer.current = null;
			}
			if (hoverCloseTimer.current != null) {
				window.clearTimeout(hoverCloseTimer.current);
			}
			hoverCloseTimer.current = window.setTimeout(() => {
				hoverCloseTimer.current = null;
				pendingHoverRef.current = null;
				setReferenceHover(null);
			}, 180);
		},
		[],
	);
	const holdReferenceHover = useCallback(() => {
		if (hoverCloseTimer.current != null) {
			window.clearTimeout(hoverCloseTimer.current);
			hoverCloseTimer.current = null;
		}
	}, []);
	const releaseReferenceHover = useCallback(() => {
		clearHoverTimers();
		pendingHoverRef.current = null;
		setReferenceHover(null);
	}, [clearHoverTimers]);
	useEffect(() => clearHoverTimers, [clearHoverTimers]);
	const selectionHover: SelectionHoverAnchor | null =
		referenceHover?.kind === "selection" ? referenceHover : null;
	const visualHover = referenceHover?.kind === "visual" ? referenceHover : null;
	const hoveredVisual = visualHover
		? (visualDrafts.find((draft) => draft.id === visualHover.id) ?? null)
		: null;
	useEffect(() => {
		if (visualHover && !hoveredVisual) releaseReferenceHover();
	}, [hoveredVisual, releaseReferenceHover, visualHover]);
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
				// Queue sits in normal flow above the shell; fixed height applies only
				// to the input shell so the waitlist never covers the composer.
				// Keep the same horizontal inset and bottom gap in both modes so
				// the InputGroup width / distance to the panel bottom do not jump
				// when crossing the compact height threshold.
				"flex shrink-0 flex-col border-t bg-muted/10 px-3 pb-3",
				compact ? "gap-1 pt-2" : "gap-2 pt-3",
			)}
		>
			{hasQueuedMessages ? (
				<ComposerQueue
					compact={compact}
					messageQueue={props.messageQueue}
					onRemoveQueuedMessage={props.onRemoveQueuedMessage}
				/>
			) : null}
			<div
				ref={shellRef}
				data-composer-drop-shell
				className={cn(
					"relative flex min-h-0 flex-col gap-1.5 overflow-hidden",
					// Compact hugs the input row; a fixed height would leave empty
					// space under the field inside the shell.
					!compact && heightPx == null && "flex-1",
				)}
				style={!compact && heightPx != null ? { height: heightPx } : undefined}
			>
				{props.currentFilePath ? (
					<div
						className={cn(
							"flex shrink-0 items-center gap-1.5",
							compact ? "flex-nowrap overflow-hidden" : "flex-wrap",
						)}
					>
						<ComposerContextChips
							currentFilePath={props.currentFilePath}
							currentFileLabel={props.currentFileLabel}
							mentionChipPaths={[]}
							directoryPathSet={props.directoryPathSet}
							paperPathSet={props.paperPathSet}
							labelForPath={props.labelForPath}
							onRemoveContextPath={props.onRemoveContextPath}
						/>
					</div>
				) : null}
				{visualHover && hoveredVisual ? (
					<VisualReferenceCard
						draft={hoveredVisual}
						index={
							annotationOrdinal(composerText, "visual", hoveredVisual.id) ??
							visualDrafts.findIndex((draft) => draft.id === hoveredVisual.id) +
								1
						}
						anchor={visualHover.anchor}
						onHoverHold={holdReferenceHover}
						onHoverRelease={releaseReferenceHover}
						onRemove={props.onRemoveVisualDraft}
					/>
				) : null}
				<div
					className={cn(
						"relative min-h-0",
						compact ? "flex items-end" : "flex-1",
					)}
				>
					<PromptInput
						className={cn("w-full", compact ? "flex items-end" : "h-full")}
						inputGroupClassName={cn(
							"!flex min-h-0 !flex-col overflow-hidden rounded-xl border border-border bg-background shadow-none transition-[background-color,box-shadow,border-color] duration-150",
							compact ? "h-auto" : "!h-full",
							// Keep the same surface while any child is disabled or a run is
							// in progress — never dim / recolor the composer for "processing".
							"has-disabled:bg-transparent has-disabled:opacity-100 dark:has-disabled:bg-input/30 dark:bg-background",
							// No focus ring / border flash while typing.
							"has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0",
							isFileDragOver &&
								"border-primary/55 bg-primary/5 shadow-[inset_0_0_0_1px] shadow-primary/25 ring-2 ring-primary/35 dark:bg-primary/5",
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
						onSubmit={async ({ files }) => {
							const images = fileUiPartsToPromptImages(files);
							// Prefer controlled draft (includes inline token markers).
							await onSubmit(composerText, images.length ? images : undefined);
						}}
					>
						<ComposerAnnotations
							value={composerText}
							onChange={onComposerTextChange}
							hover={selectionHover}
							onHoverHold={holdReferenceHover}
							onHoverRelease={releaseReferenceHover}
						/>
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
											"relative flex w-full overflow-hidden",
											compact
												? // Single-line, vertically centered. py-2.5 matches the
													// expanded footer pb-2.5 so the send button sits on the
													// same bottom inset when crossing the compact threshold.
													"min-h-0 flex-row items-center gap-1 px-3 py-2.5"
												: "min-h-0 flex-1 flex-col px-3 pt-3",
										)}
										onVaultPathDragOver={onComposerDragOver}
										onVaultPathDrop={onComposerDrop}
									>
										<ComposerImageAttachments compact={compact} />
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
												onSkillActiveIndexChange={
													props.onSkillActiveIndexChange
												}
											/>
										) : null}
										{showSlashMenu ? (
											<ComposerSlashMenu
												slashOptions={props.slashOptions}
												slashActiveIndex={slashActiveIndex}
												onAttachSlashCommand={props.onAttachSlashCommand}
												onSlashActiveIndexChange={
													props.onSlashActiveIndexChange
												}
											/>
										) : null}
										<ComposerInlineInput
											ref={props.composerInputRef}
											autoFocus={Boolean(autoFocus)}
											compact={compact}
											value={composerText}
											onValueChange={onComposerTextChange}
											onKeyDown={onComposerKeyDown}
											disabled={switching}
											labelForPath={props.labelForPath}
											visualDrafts={visualDrafts}
											onSelectionPointer={(phase, id, anchor) =>
												onReferencePointer("selection", phase, id, anchor)
											}
											onVisualPointer={(phase, id, anchor) =>
												onReferencePointer("visual", phase, id, anchor)
											}
											skillLabel={(skillId) =>
												props.selectedSkills.find((s) => s.id === skillId)
													?.name ??
												props.skillOptions.find((s) => s.id === skillId)
													?.name ??
												skillId
											}
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
											placeholder={
												activeTabIsRunning ? "" : t("composer.placeholder")
											}
										/>
										{compact ? (
											<ComposerSubmitControl
												canSubmitBase={canSubmitBase}
												switching={switching}
												submitting={submitting}
												activeTabIsRunning={activeTabIsRunning}
												compact
												onCancelRun={onCancelRun}
											/>
										) : null}
									</ComposerDropTarget>
								</PopoverAnchor>
							</Popover>
						</PromptInputBody>
						{compact ? null : (
							<PromptInputFooter className="flex-wrap items-end gap-x-2 gap-y-1.5 px-3 pb-2.5">
								<PromptInputTools className="min-w-0 flex-1 flex-wrap gap-1">
									<ComposerToolbar
										switching={switching}
										activeUsage={props.activeUsage}
									/>
								</PromptInputTools>
								<ComposerSubmitControl
									canSubmitBase={canSubmitBase}
									switching={switching}
									submitting={submitting}
									activeTabIsRunning={activeTabIsRunning}
									onCancelRun={onCancelRun}
								/>
							</PromptInputFooter>
						)}
					</PromptInput>
					{isFileDragOver ? (
						<div
							className={cn(
								"pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl",
								"border-2 border-primary/50 border-dashed bg-primary/10 backdrop-blur-[1px]",
							)}
							aria-hidden
						>
							<div className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/90 px-3 py-1.5 text-primary text-xs font-medium shadow-raised">
								<ImageIcon className="size-3.5 shrink-0" />
								<span>{t("composer.dropImageHint")}</span>
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
