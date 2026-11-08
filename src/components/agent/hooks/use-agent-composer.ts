/**
 * Composer UI state: context chips, @mention / $skill / /slash menus with
 * keyboard navigation, drag-drop path attach, ↑/↓ prompt recall, and the
 * cross-window composer seed.
 */
import {
	type Dispatch,
	type KeyboardEvent,
	type DragEvent as ReactDragEvent,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ComposerInlineInputHandle } from "@/components/agent/composer/composer-inline-input";
import type { AgentPanelRefs } from "@/components/agent/hooks/use-agent-panel-context";
import { usePlazaMentionSource } from "@/components/agent/hooks/use-plaza-mention-source";
import {
	useSelectionStore,
	useVisualContextStore,
} from "@/hooks/use-app-stores";
import type { useSessionComposerState } from "@/hooks/use-session-composer-state";
import type { AgentSkill } from "@/lib/agent";
import type { ChatLine } from "@/lib/agent/chat-state";
import {
	appendMissingInlineTokens,
	encodeCommandToken,
	encodeMentionToken,
	encodeSelectionToken,
	encodeSkillToken,
	encodeVisualToken,
	extractMentionPaths,
	extractSelectionTokens,
	extractSkillIds,
	extractVisualIds,
	insertTokensAt,
	plainTriggerSuffix,
	referenceInsertionOffset,
	removeVisualToken,
	replaceSelectionToken,
	replaceTrailingTriggerWithToken,
} from "@/lib/agent/composer-inline-tokens";
import {
	subscribePendingAgentComposerPrompt,
	takePendingAgentComposerPrompt,
} from "@/lib/agent/composer-seed";
import { composerScopeKey } from "@/lib/agent/composer-state";
import {
	listenAgentAttachContext,
	subscribePendingAgentContextPaths,
	takePendingAgentContextPaths,
} from "@/lib/agent/context-attach";
import {
	contextPathDisplayName,
	normalizeContextPath,
} from "@/lib/agent/context-path-icon";
import {
	buildMentionCandidatePaths,
	filterMentionOptions,
	loadRecentMentionPaths,
	mentionParentPath,
	mentionPathHasChildren,
	pushRecentMentionPath,
} from "@/lib/agent/mention";
import { isPlazaCollectionPath } from "@/lib/agent/plaza-mention";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import {
	removeSelection,
	type SelectionContext,
} from "@/lib/agent/selection-store";
import {
	type AcpCommand,
	acpCommandInvocation,
	buildSlashOptions,
} from "@/lib/agent/slash-commands";
import {
	forgetVisualInsertRequests,
	type PdfVisualDraft,
	pendingVisualInsertIds,
	removeVisualDraft,
} from "@/lib/agent/visual-context-store";
import {
	planVisualMarkerSync,
	type VisualMarkerBaseline,
} from "@/lib/agent/visual-marker-sync";
import {
	dataTransferLooksLikeImages,
	dataTransferLooksLikePdfs,
	dataTransferLooksLikeVaultMove,
	dataTransferTypes,
} from "@/lib/core/file-accept";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import { toSafeDisposer } from "@/lib/core/tauri-events";
import {
	collectUserPromptTexts,
	nextHistoryIndexOnDown,
	nextHistoryIndexOnUp,
	shouldNavigateHistoryDown,
	shouldNavigateHistoryUp,
} from "@/lib/ui/prompt-recall";
import { toVaultRelative } from "@/lib/wiki";

export type UseAgentComposerOptions = {
	refs: Pick<
		AgentPanelRefs,
		| "promptHistoryAppliedRef"
		| "promptHistoryDraftRef"
		| "promptHistoryIndexRef"
		| "switchingRef"
	>;
	composer: ReturnType<typeof useSessionComposerState>;
	vaultPath: string | null;
	vaultMarkdownPaths: string[];
	vaultDirectoryPaths: string[];
	vaultPaperPaths: string[];
	selectedPaperTitle: string | null;
	selectedVaultPath: string | null;
	paperPathSet: ReadonlySet<string>;
	labelForPath: (path: string) => string;
	mentionLabelsByPath: Map<string, string>;
	contextPaths: string[];
	currentFilePath: string | null;
	skills: AgentSkill[];
	acpCommandsByAgent: Record<string, AcpCommand[]>;
	selectedAgentId: string | null;
	/** Active composer session. Visual markers are diffed inside this identity. */
	sessionId: string;
	lines: ChatLine[];
	activeTabIsRunning: boolean;
	cancelCurrentRun: () => Promise<void>;
};

export type AgentComposer = {
	composerMenuDismissed: boolean;
	setComposerMenuDismissed: Dispatch<SetStateAction<boolean>>;
	mentionActiveIndex: number;
	setMentionActiveIndex: Dispatch<SetStateAction<number>>;
	skillActiveIndex: number;
	setSkillActiveIndex: Dispatch<SetStateAction<number>>;
	slashActiveIndex: number;
	setSlashActiveIndex: Dispatch<SetStateAction<number>>;
	currentFileLabel: string;
	mentionChipPaths: string[];
	visualDrafts: PdfVisualDraft[];
	removeContextPath: (path: string) => void;
	selectedSkills: AgentSkill[];
	showMentionMenu: boolean;
	mentionBrowseRoot: string | null;
	mentionOptions: string[];
	mentionCandidates: string[];
	leaveMentionFolder: () => void;
	enterMentionFolder: (path: string) => void;
	attachMention: (path: string) => void;
	showSkillMenu: boolean;
	skillOptions: AgentSkill[];
	attachSkill: (skill: AgentSkill) => void;
	removeSkill: (skillId: string) => void;
	showSlashMenu: boolean;
	slashOptions: AcpCommand[];
	attachSlashCommand: (command: AcpCommand) => void;
	attachContextPaths: (rawPaths: string[]) => void;
	handleComposerDragOver: (e: ReactDragEvent) => void;
	handleComposerDrop: (e: ReactDragEvent) => void;
	handleComposerMenuKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onComposerTextChangeFromUser: (text: string) => void;
	/** Ref to the inline input, used to insert selections at the caret. */
	composerInputRef: RefObject<ComposerInlineInputHandle | null>;
};

export function useAgentComposer({
	refs: {
		promptHistoryAppliedRef,
		promptHistoryDraftRef,
		promptHistoryIndexRef,
		switchingRef,
	},
	composer: {
		text: composerText,
		mentionedPaths,
		selectedSkillIds,
		setText: setComposerText,
		setIncludeSelectedFile,
		setMentionedPaths,
		setSelectedSkillIds,
		snapshot: snapshotComposer,
		composerIdentity,
	},
	vaultPath,
	vaultMarkdownPaths,
	vaultDirectoryPaths,
	vaultPaperPaths,
	selectedPaperTitle,
	selectedVaultPath,
	paperPathSet,
	labelForPath,
	mentionLabelsByPath,
	contextPaths,
	currentFilePath,
	skills,
	acpCommandsByAgent,
	selectedAgentId,
	sessionId,
	lines,
	activeTabIsRunning,
	cancelCurrentRun,
}: UseAgentComposerOptions): AgentComposer {
	const [composerMenuDismissed, setComposerMenuDismissed] = useState(false);
	const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
	const [skillActiveIndex, setSkillActiveIndex] = useState(0);
	const [slashActiveIndex, setSlashActiveIndex] = useState(0);

	// Doctor / Settings may seed the composer via a cross-window event.
	useEffect(() => {
		const apply = (text: string) => {
			const next = text.trim();
			if (!next) return;
			setComposerText(next);
			setComposerMenuDismissed(true);
		};
		const pending = takePendingAgentComposerPrompt();
		if (pending) apply(pending);
		return subscribePendingAgentComposerPrompt(apply);
	}, [setComposerText]);

	/** Same paper label mode as the file tree (settings); title fallback if meta missing. */
	const currentFileLabel = useMemo(() => {
		if (!currentFilePath) return "";
		const labeled = labelForPath(currentFilePath);
		if (labeled && labeled !== contextPathDisplayName(currentFilePath)) {
			return labeled;
		}
		const title = selectedPaperTitle?.trim();
		if (title && paperPathSet.has(normalizeContextPath(currentFilePath))) {
			return title;
		}
		return labeled || contextPathDisplayName(currentFilePath);
	}, [currentFilePath, labelForPath, paperPathSet, selectedPaperTitle]);

	// Re-attach when the focused document/paper changes (user can still remove via X).
	useEffect(() => {
		if (!selectedVaultPath) return;
		setIncludeSelectedFile(true);
	}, [selectedVaultPath, setIncludeSelectedFile]);

	const mentionChipPaths = useMemo(
		() => contextPaths.filter((path) => path !== selectedVaultPath),
		[contextPaths, selectedVaultPath],
	);

	// Ref exposed to AgentComposer so it can be wired to ComposerInlineInput.
	const composerInputRef = useRef<ComposerInlineInputHandle>(null);

	// Only explicitly pinned selections (Add to chat / ⇧⌘L) enter the draft.
	// Live drag-selection stays in the store until pinActiveSelection freezes it.
	const pinnedSelections = useSelectionStore((s) => s.pinned);

	// Pin quotes at the caret the composer last reported. Appending at the
	// string end lands after the contenteditable's trailing break, which
	// paints the reference on its own line.
	const prevPinnedRef = useRef<SelectionContext[]>([]);
	useEffect(() => {
		const prev = prevPinnedRef.current;
		const inserted: SelectionContext[] = [];
		for (const sel of pinnedSelections) {
			if (!prev.some((p) => p.id === sel.id)) {
				inserted.push(sel);
			}
		}
		if (inserted.length > 0) {
			const caret = composerInputRef.current?.getCaretOffset() ?? null;
			setComposerText((current) => {
				const existing = new Set(
					extractSelectionTokens(current).map((selection) => selection.id),
				);
				let next = current;
				for (const selection of inserted) {
					if (existing.has(selection.id)) {
						next = replaceSelectionToken(next, selection);
					}
				}
				const tokens = inserted
					.filter((selection) => !existing.has(selection.id))
					.map(encodeSelectionToken)
					.join("");
				if (!tokens) return next;
				const result = insertTokensAt(
					next,
					referenceInsertionOffset(next, caret),
					tokens,
				);
				composerInputRef.current?.setPendingCaret(result.caret, result.text);
				return result.text;
			});
			for (const sel of inserted) {
				removeSelection(sel.id);
			}
		}
		prevPinnedRef.current = pinnedSelections;
	}, [pinnedSelections, setComposerText]);

	const visualDrafts = useVisualContextStore((s) => s.drafts);
	const visualSyncRef = useRef<VisualMarkerBaseline | null>(null);
	// Keep this session's visual drafts and inline markers in step.
	// Switching sessions shows that session's own bucket; it does not delete
	// or rewrite another session's unsent block. An explicit add inserts into
	// the composer that is open.
	useEffect(() => {
		const liveIdentity = composerIdentity();
		const liveText = snapshotComposer().text;
		if (
			liveText !== composerText ||
			liveIdentity.sessionId !== sessionId ||
			liveIdentity.scopeKey !== composerScopeKey(vaultPath, selectedAgentId)
		) {
			return;
		}
		const identity = `${liveIdentity.scopeKey ?? ""}\n${liveIdentity.sessionId}`;
		const textIds = extractVisualIds(composerText);
		const storeIds = visualDrafts.map((draft) => draft.id);
		const requestedIds = pendingVisualInsertIds(identity).filter((id) =>
			storeIds.includes(id),
		);
		const plan = planVisualMarkerSync({
			identity,
			textIds,
			storeIds,
			prev: visualSyncRef.current,
			requestedIds,
		});
		visualSyncRef.current = { identity, textIds, storeIds };

		for (const id of plan.removeDraftIds) removeVisualDraft(id);

		if (plan.insertDraftIds.length > 0) {
			const caret = composerInputRef.current?.getCaretOffset() ?? null;
			setComposerText((current) => {
				const have = new Set(extractVisualIds(current));
				const tokens = plan.insertDraftIds
					.filter((id) => !have.has(id))
					.map((id) => encodeVisualToken(id))
					.join("");
				if (!tokens) return current;
				const result = insertTokensAt(
					current,
					referenceInsertionOffset(current, caret),
					tokens,
				);
				composerInputRef.current?.setPendingCaret(result.caret, result.text);
				return result.text;
			});
		}

		if (plan.stripMarkerIds.length > 0) {
			setComposerText((current) => {
				const next = plan.stripMarkerIds.reduce(
					(text, id) => removeVisualToken(text, id),
					current,
				);
				return next === current ? current : next;
			});
		}
		const removed = new Set(plan.removeDraftIds);
		forgetVisualInsertRequests(
			identity,
			textIds,
			storeIds.filter((id) => !removed.has(id)),
		);
	}, [
		composerIdentity,
		composerText,
		selectedAgentId,
		sessionId,
		setComposerText,
		snapshotComposer,
		vaultPath,
		visualDrafts,
	]);

	// Markers count as atoms so `$` / `@` inside `{{s:…}}` / `{{m:…}}` stay inert.
	const triggerText = plainTriggerSuffix(composerText);
	const mentionMatch = triggerText.match(/(^|\s|\uFFFC)@([^\s]*)$/);
	/** Raw @query (preserve case for display; matching is case-insensitive). */
	const mentionQueryRaw = mentionMatch?.[2] ?? "";
	const mentionQuery = mentionQueryRaw.toLocaleLowerCase();

	const plazaMentionEntries = usePlazaMentionSource(vaultPath);

	const mentionCandidates = useMemo(() => {
		const vaultPaths = buildMentionCandidatePaths({
			markdownPaths: vaultMarkdownPaths,
			directoryPaths: vaultDirectoryPaths,
			paperPaths: vaultPaperPaths,
		});
		// Plaza entries are virtual leaves (arXiv Daily / Feeds); they surface
		// on typed title queries or as recents, never in the shallow tree.
		return [...vaultPaths, ...plazaMentionEntries.map((entry) => entry.path)];
	}, [
		plazaMentionEntries,
		vaultDirectoryPaths,
		vaultMarkdownPaths,
		vaultPaperPaths,
	]);

	/** Vault paper titles + plaza titles/sources, both searchable via `@`. */
	const mentionSearchLabels = useMemo(() => {
		if (plazaMentionEntries.length === 0) return mentionLabelsByPath;
		const map = new Map(mentionLabelsByPath);
		for (const entry of plazaMentionEntries) {
			map.set(entry.path, `${entry.title} ${entry.sourceLabel}`);
		}
		return map;
	}, [mentionLabelsByPath, plazaMentionEntries]);

	const [recentMentionPaths, setRecentMentionPaths] = useState<string[]>(() => {
		try {
			return loadRecentMentionPaths(
				typeof localStorage === "undefined" ? null : localStorage,
				vaultPath,
			);
		} catch {
			return [];
		}
	});

	/**
	 * In-folder browse for `@` menu (null = root: recents + shallow tree).
	 * Chevron on the right drills into directories; papers stay leaves.
	 */
	const [mentionBrowseRoot, setMentionBrowseRoot] = useState<string | null>(
		null,
	);

	// Reload recents when Vault changes; leave any open folder browser.
	useEffect(() => {
		try {
			setRecentMentionPaths(
				loadRecentMentionPaths(
					typeof localStorage === "undefined" ? null : localStorage,
					vaultPath,
				),
			);
		} catch {
			setRecentMentionPaths([]);
		}
		setMentionBrowseRoot(null);
	}, [vaultPath]);

	// Close folder browser when `@` is gone or the menu is dismissed.
	useEffect(() => {
		if (!mentionMatch || composerMenuDismissed) {
			setMentionBrowseRoot(null);
		}
	}, [composerMenuDismissed, mentionMatch]);

	/** Whole-list entries (the arXiv Daily collection) stay visible at `@`. */
	const pinnedMentionPaths = useMemo(() => {
		const pinned = plazaMentionEntries
			.map((entry) => entry.path)
			.filter(isPlazaCollectionPath);
		return pinned.length ? pinned : null;
	}, [plazaMentionEntries]);

	const mentionOptions = useMemo(() => {
		if (!mentionMatch) return [];
		return filterMentionOptions({
			candidates: mentionCandidates,
			query: mentionQuery,
			exclude: contextPaths,
			recent: recentMentionPaths,
			labelsByPath: mentionSearchLabels,
			browseRoot: mentionBrowseRoot,
			pinned: pinnedMentionPaths,
			limit: 8,
		});
	}, [
		contextPaths,
		mentionBrowseRoot,
		mentionCandidates,
		mentionMatch,
		mentionQuery,
		mentionSearchLabels,
		pinnedMentionPaths,
		recentMentionPaths,
	]);

	const enterMentionFolder = useCallback((path: string) => {
		setMentionBrowseRoot(path);
		setMentionActiveIndex(0);
		setComposerMenuDismissed(false);
	}, []);

	const leaveMentionFolder = useCallback(() => {
		setMentionBrowseRoot((current) => {
			if (!current) return null;
			return mentionParentPath(current);
		});
		setMentionActiveIndex(0);
	}, []);

	const skillMatch = triggerText.match(/(^|\s|\uFFFC)\$([^\s]*)$/);
	const skillQuery = skillMatch?.[2]?.toLocaleLowerCase() ?? "";
	const skillOptions = useMemo(() => {
		if (!skillMatch) return [];
		return skills
			.filter((skill) => {
				const searchable =
					`${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase();
				return searchable.includes(skillQuery);
			})
			.filter((skill) => !selectedSkillIds.includes(skill.id))
			.slice(0, 6);
	}, [selectedSkillIds, skillMatch, skillQuery, skills]);

	const slashMatch = triggerText.match(/(^|\s|\uFFFC)\/([^\s]*)$/);
	const slashQuery = slashMatch?.[2]?.toLocaleLowerCase() ?? "";
	const slashCommands = acpCommandsByAgent[selectedAgentId ?? ""] ?? [];
	const slashOptions = useMemo(() => {
		if (!slashMatch) return [];
		return buildSlashOptions(slashCommands, skills, slashQuery, {
			selectedSkillIds: new Set(selectedSkillIds),
		});
	}, [slashCommands, slashMatch, slashQuery, selectedSkillIds, skills]);

	const showMentionMenu =
		!composerMenuDismissed &&
		Boolean(mentionMatch) &&
		(mentionOptions.length > 0 || mentionBrowseRoot != null);
	const showSkillMenu = !composerMenuDismissed && skillOptions.length > 0;
	const showSlashMenu = !composerMenuDismissed && slashOptions.length > 0;

	useEffect(() => {
		setMentionActiveIndex((index) =>
			mentionOptions.length
				? Math.max(0, Math.min(index, mentionOptions.length - 1))
				: 0,
		);
	}, [mentionOptions.length]);

	useEffect(() => {
		setSkillActiveIndex((index) =>
			skillOptions.length
				? Math.max(0, Math.min(index, skillOptions.length - 1))
				: 0,
		);
	}, [skillOptions.length]);

	useEffect(() => {
		setSlashActiveIndex((index) =>
			slashOptions.length
				? Math.max(0, Math.min(index, slashOptions.length - 1))
				: 0,
		);
	}, [slashOptions.length]);

	const selectedSkills = useMemo(
		() =>
			selectedSkillIds
				.map((id) => skills.find((skill) => skill.id === id))
				.filter((skill): skill is AgentSkill => Boolean(skill)),
		[selectedSkillIds, skills],
	);

	/** Insert @mention token(s) at the trailing trigger / end of the draft. */
	const attachContextPaths = useCallback(
		(rawPaths: string[]) => {
			const normalized = rawPaths
				.map((p) => toVaultRelative(vaultPath, p.trim()))
				.filter((p) => p.length > 0);
			if (!normalized.length) return;
			// Remember for empty-`@` recent hints (per Vault).
			try {
				const storage =
					typeof localStorage === "undefined" ? null : localStorage;
				let recents: string[] = [];
				for (const path of normalized) {
					recents = pushRecentMentionPath(storage, vaultPath, path);
				}
				if (recents.length) setRecentMentionPaths(recents);
			} catch {
				// ignore quota / private mode
			}
			setComposerMenuDismissed(true);
			setComposerText((prev) => {
				let next = prev;
				for (const path of normalized) {
					const token = encodeMentionToken(path);
					if (next.includes(token)) continue;
					next = replaceTrailingTriggerWithToken(next, "mention", token);
				}
				setMentionedPaths(extractMentionPaths(next));
				return next;
			});
		},
		[setComposerText, setMentionedPaths, vaultPath],
	);

	const attachMention = useCallback(
		(path: string) => {
			attachContextPaths([path]);
			setMentionBrowseRoot(null);
		},
		[attachContextPaths],
	);

	const removeContextPath = (path: string) => {
		if (path === selectedVaultPath) {
			setIncludeSelectedFile(false);
			return;
		}
		const token = encodeMentionToken(path);
		setComposerText((prev) => {
			const next = prev
				.split(token)
				.join("")
				.replace(/[ \t]{2,}/g, " ");
			setMentionedPaths(extractMentionPaths(next));
			return next;
		});
	};

	// Legacy drafts: paths/skills in state but not yet embedded as inline tokens.
	useEffect(() => {
		const next = appendMissingInlineTokens(
			composerText,
			mentionedPaths,
			selectedSkillIds,
		);
		if (next === composerText) return;
		setComposerText(next);
		setMentionedPaths(extractMentionPaths(next));
		setSelectedSkillIds(extractSkillIds(next));
	}, [
		composerText,
		mentionedPaths,
		selectedSkillIds,
		setComposerText,
		setMentionedPaths,
		setSelectedSkillIds,
	]);

	// File tree "Add to chat" → drop paths as context chips (same as @-mention).
	// Handles same-window (module pub/sub) and the singleton feature window
	// (Tauri event). Consumes one pending batch on mount.
	useEffect(() => {
		const pending = takePendingAgentContextPaths();
		if (pending) attachContextPaths(pending);
		const unsubscribe = subscribePendingAgentContextPaths(attachContextPaths);
		const unlisten = toSafeDisposer(
			listenAgentAttachContext(attachContextPaths),
		);
		return () => {
			unsubscribe();
			unlisten();
		};
	}, [attachContextPaths]);

	/**
	 * Drag from file tree sets `text/plain` vault paths (newline-separated).
	 * Capture as context chips instead of inserting raw path text into the textarea.
	 * Reuses the same chip UI as `@` mentions — not AI Elements Attachments
	 * (those are FileUIPart blobs; ACP context is path-based).
	 */
	const handleComposerDragOver = useCallback((e: ReactDragEvent) => {
		const types = dataTransferTypes(e.dataTransfer);
		if (!types.length) return;
		const hasText = types.includes("text/plain") || types.includes("Text");
		const hasFiles = types.includes("Files");
		// In-app file-tree drags stay path chips. OS file drops (often
		// text/plain path + Files) belong to PromptInput / image attach.
		if (
			dataTransferLooksLikeVaultMove(e.dataTransfer) ||
			(hasText && !hasFiles)
		) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		}
	}, []);

	const handleComposerDrop = useCallback(
		(e: ReactDragEvent) => {
			// PDF drops belong to the app-wide importer, even when the composer
			// receives a text/plain path alongside the file payload.
			if (
				!dataTransferLooksLikeVaultMove(e.dataTransfer) &&
				dataTransferLooksLikePdfs(e.dataTransfer)
			) {
				return;
			}
			// Finder / Preview / other-app image drops include text/plain paths
			// AND Files. Those belong to PromptInput, not @ context chips.
			// In-app tree moves always stay path chips.
			if (
				!dataTransferLooksLikeVaultMove(e.dataTransfer) &&
				dataTransferLooksLikeImages(e.dataTransfer)
			) {
				return;
			}
			const text = e.dataTransfer?.getData("text/plain")?.trim();
			if (!text) return;
			// Ignore non-path payloads (e.g. plain prose selection).
			const lines = text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			const pathLike = lines.filter(
				(line) =>
					!line.includes("://") &&
					(line.includes("/") ||
						line.includes("\\") ||
						/\.(md|pdf|tex|bib|json|txt|html?)$/i.test(line)),
			);
			if (!pathLike.length) return;
			e.preventDefault();
			e.stopPropagation();
			attachContextPaths(pathLike);
		},
		[attachContextPaths],
	);

	const attachSkill = useCallback(
		(skill: AgentSkill) => {
			setComposerMenuDismissed(true);
			setComposerText((prev) => {
				const token = encodeSkillToken(skill.id);
				if (prev.includes(token)) {
					setSelectedSkillIds(extractSkillIds(prev));
					return prev.replace(
						/(^|\s)[/$][^\s]*$/,
						(_m, prefix: string) => `${prefix}`,
					);
				}
				const next = replaceTrailingTriggerWithToken(prev, "skill", token);
				setSelectedSkillIds(extractSkillIds(next));
				return next;
			});
		},
		[setComposerText, setSelectedSkillIds],
	);

	const removeSkill = useCallback(
		(skillId: string) => {
			const token = encodeSkillToken(skillId);
			setComposerText((prev) => {
				const next = prev
					.split(token)
					.join("")
					.replace(/[ \t]{2,}/g, " ");
				setSelectedSkillIds(extractSkillIds(next));
				return next;
			});
		},
		[setComposerText, setSelectedSkillIds],
	);

	const attachSlashCommand = useCallback(
		(command: AcpCommand) => {
			if (command.kind === "skill") {
				attachSkill({
					id: command.name,
					name: command.title,
					description: command.description,
				});
				return;
			}
			setComposerMenuDismissed(true);
			setComposerText((prev) => {
				const token = encodeCommandToken(acpCommandInvocation(command));
				if (prev.includes(token)) {
					return prev.replace(
						/(^|\s)[/$][^\s]*$/,
						(_m, prefix: string) => `${prefix}`,
					);
				}
				return replaceTrailingTriggerWithToken(prev, "command", token);
			});
		},
		[attachSkill, setComposerText],
	);

	const handleComposerMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		// IME: do not treat Enter as mention/skill select while composing.
		// PromptInputTextarea owns compositionend grace + blocks submit; here
		// we only need keyCode 229 / isComposing so menus do not steal the key.
		if (event.key === "Enter" && isImeKeyboardEvent(event)) {
			return;
		}

		if (event.key === "Escape" && activeTabIsRunning) {
			event.preventDefault();
			void cancelCurrentRun();
			return;
		}

		if (
			event.key === "Escape" &&
			(showMentionMenu || showSkillMenu || showSlashMenu)
		) {
			event.preventDefault();
			// While browsing a folder, Esc steps up; only dismiss at root.
			if (showMentionMenu && mentionBrowseRoot) {
				leaveMentionFolder();
				return;
			}
			setComposerMenuDismissed(true);
			setMentionBrowseRoot(null);
			return;
		}

		if (showMentionMenu) {
			if (event.key === "ArrowLeft" && mentionBrowseRoot) {
				event.preventDefault();
				leaveMentionFolder();
				return;
			}
			if (event.key === "ArrowRight") {
				const path =
					mentionOptions[mentionActiveIndex] ?? mentionOptions[0] ?? null;
				if (
					path &&
					mentionPathHasChildren(path, mentionCandidates, paperPathSet)
				) {
					event.preventDefault();
					enterMentionFolder(path);
					return;
				}
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (mentionOptions.length === 0) return;
				setMentionActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % mentionOptions.length
						: (index - 1 + mentionOptions.length) % mentionOptions.length,
				);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const path = mentionOptions[mentionActiveIndex] ?? mentionOptions[0];
				if (path) attachMention(path);
			}
			return;
		}

		if (showSkillMenu) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setSkillActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % skillOptions.length
						: (index - 1 + skillOptions.length) % skillOptions.length,
				);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const skill = skillOptions[skillActiveIndex] ?? skillOptions[0];
				if (skill) attachSkill(skill);
			}
			return;
		}

		if (showSlashMenu) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setSlashActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % slashOptions.length
						: (index - 1 + slashOptions.length) % slashOptions.length,
				);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const command = slashOptions[slashActiveIndex] ?? slashOptions[0];
				if (command) attachSlashCommand(command);
			}
			return;
		}

		// ↑ / ↓ → walk previous user prompts (shell-style). Contenteditable has
		// no .value; treat an empty marked draft as empty and ignore caret while
		// already browsing so chips/markers do not block ArrowDown.
		if (switchingRef.current) return;
		const isBrowsing = promptHistoryIndexRef.current !== null;
		const history = collectUserPromptTexts(
			lines,
			stripPromptEnvelopeForDisplay,
		);
		const historyTarget = {
			value: composerText,
			selectionStart: isBrowsing ? 0 : composerText.trim() === "" ? 0 : 1,
			selectionEnd: isBrowsing ? 0 : composerText.trim() === "" ? 0 : 1,
		};

		if (shouldNavigateHistoryUp(event, historyTarget, isBrowsing)) {
			if (history.length === 0) return;
			event.preventDefault();
			if (!isBrowsing) {
				promptHistoryDraftRef.current = composerText;
			}
			const nextIndex = nextHistoryIndexOnUp(
				history.length,
				promptHistoryIndexRef.current,
			);
			if (nextIndex === null) return;
			const text = history[nextIndex] ?? "";
			promptHistoryIndexRef.current = nextIndex;
			promptHistoryAppliedRef.current = text;
			setComposerText(text);
			return;
		}

		const downTarget = {
			value: composerText,
			selectionStart: composerText.length,
			selectionEnd: composerText.length,
		};
		if (shouldNavigateHistoryDown(event, downTarget, isBrowsing)) {
			event.preventDefault();
			const nextIndex = nextHistoryIndexOnDown(
				history.length,
				promptHistoryIndexRef.current,
			);
			if (nextIndex === null) {
				const draft = promptHistoryDraftRef.current;
				promptHistoryIndexRef.current = null;
				promptHistoryDraftRef.current = "";
				promptHistoryAppliedRef.current = null;
				setComposerText(draft);
				return;
			}
			const text = history[nextIndex] ?? "";
			promptHistoryIndexRef.current = nextIndex;
			promptHistoryAppliedRef.current = text;
			setComposerText(text);
		}
	};

	/** Clear ↑/↓ history browse when the user edits the recalled text. */
	const onComposerTextChangeFromUser = useCallback(
		(text: string) => {
			if (
				promptHistoryIndexRef.current !== null &&
				text !== promptHistoryAppliedRef.current
			) {
				promptHistoryIndexRef.current = null;
				promptHistoryDraftRef.current = "";
				promptHistoryAppliedRef.current = null;
			}
			setComposerText(text);
			setMentionedPaths(extractMentionPaths(text));
			setSelectedSkillIds(extractSkillIds(text));
		},
		[
			promptHistoryAppliedRef,
			promptHistoryDraftRef,
			promptHistoryIndexRef,
			setComposerText,
			setMentionedPaths,
			setSelectedSkillIds,
		],
	);

	return {
		composerMenuDismissed,
		setComposerMenuDismissed,
		mentionActiveIndex,
		setMentionActiveIndex,
		skillActiveIndex,
		setSkillActiveIndex,
		slashActiveIndex,
		setSlashActiveIndex,
		currentFileLabel,
		mentionChipPaths,
		visualDrafts,
		removeContextPath,
		selectedSkills,
		showMentionMenu,
		mentionBrowseRoot,
		mentionOptions,
		mentionCandidates,
		leaveMentionFolder,
		enterMentionFolder,
		attachMention,
		showSkillMenu,
		skillOptions,
		attachSkill,
		removeSkill,
		showSlashMenu,
		slashOptions,
		attachSlashCommand,
		attachContextPaths,
		handleComposerDragOver,
		handleComposerDrop,
		handleComposerMenuKeyDown,
		onComposerTextChangeFromUser,
		composerInputRef,
	};
}
