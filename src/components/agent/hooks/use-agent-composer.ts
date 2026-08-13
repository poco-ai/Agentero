/**
 * Composer UI state: context chips, @mention / $skill / /slash menus with
 * keyboard navigation, drag-drop path attach, ↑/↓ prompt recall, and the
 * cross-window composer seed.
 */
import {
	type Dispatch,
	type KeyboardEvent,
	type DragEvent as ReactDragEvent,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { AgentPanelRefs } from "@/components/agent/hooks/use-agent-panel-context";
import {
	useSelectionStore,
	useVisualContextStore,
} from "@/hooks/use-app-stores";
import type { useSessionComposerState } from "@/hooks/use-session-composer-state";
import type { AgentSkill } from "@/lib/agent";
import type { ChatLine } from "@/lib/agent/chat-state";
import {
	subscribePendingAgentComposerPrompt,
	takePendingAgentComposerPrompt,
} from "@/lib/agent/composer-seed";
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
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import type { SelectionContext } from "@/lib/agent/selection-store";
import {
	type AcpCommand,
	filterSlashCommands,
} from "@/lib/agent/slash-commands";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import {
	dataTransferLooksLikeImages,
	dataTransferLooksLikeVaultMove,
	dataTransferTypes,
} from "@/lib/core/file-accept";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import {
	collectUserPromptTexts,
	nextHistoryIndexOnDown,
	nextHistoryIndexOnUp,
	placeCaretAtEnd,
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
	selectionChips: SelectionContext[];
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
	showSlashMenu: boolean;
	slashOptions: AcpCommand[];
	attachSlashCommand: (command: AcpCommand) => void;
	attachContextPaths: (rawPaths: string[]) => void;
	handleComposerDragOver: (e: ReactDragEvent) => void;
	handleComposerDrop: (e: ReactDragEvent) => void;
	handleComposerMenuKeyDown: (
		event: KeyboardEvent<HTMLTextAreaElement>,
	) => void;
	onComposerTextChangeFromUser: (text: string) => void;
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
		selectedSkillIds,
		setText: setComposerText,
		setIncludeSelectedFile,
		setMentionedPaths,
		setSelectedSkillIds,
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

	// Editor/PDF selection chips: pinned first, live selection last (Cursor-style).
	const activeSelection = useSelectionStore((s) => s.active);
	const pinnedSelections = useSelectionStore((s) => s.pinned);
	const selectionChips = useMemo(
		() =>
			activeSelection
				? [...pinnedSelections, activeSelection]
				: pinnedSelections,
		[activeSelection, pinnedSelections],
	);
	const visualDrafts = useVisualContextStore((s) => s.drafts);

	const mentionMatch = composerText.match(/(^|\s)@([^\s]*)$/);
	/** Raw @query (preserve case for display; matching is case-insensitive). */
	const mentionQueryRaw = mentionMatch?.[2] ?? "";
	const mentionQuery = mentionQueryRaw.toLocaleLowerCase();

	const mentionCandidates = useMemo(
		() =>
			buildMentionCandidatePaths({
				markdownPaths: vaultMarkdownPaths,
				directoryPaths: vaultDirectoryPaths,
				paperPaths: vaultPaperPaths,
			}),
		[vaultDirectoryPaths, vaultMarkdownPaths, vaultPaperPaths],
	);

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

	const mentionOptions = useMemo(() => {
		if (!mentionMatch) return [];
		return filterMentionOptions({
			candidates: mentionCandidates,
			query: mentionQuery,
			exclude: contextPaths,
			recent: recentMentionPaths,
			labelsByPath: mentionLabelsByPath,
			browseRoot: mentionBrowseRoot,
			limit: 8,
		});
	}, [
		contextPaths,
		mentionBrowseRoot,
		mentionCandidates,
		mentionLabelsByPath,
		mentionMatch,
		mentionQuery,
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

	const skillMatch = composerText.match(/(^|\s)\$([^\s]*)$/);
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

	const slashMatch = composerText.match(/(^|\s)\/([^\s]*)$/);
	const slashQuery = slashMatch?.[2]?.toLocaleLowerCase() ?? "";
	const slashCommands = acpCommandsByAgent[selectedAgentId ?? ""] ?? [];
	const slashOptions = useMemo(() => {
		if (!slashMatch) return [];
		return filterSlashCommands(slashCommands, slashQuery);
	}, [slashCommands, slashMatch, slashQuery]);

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

	/** Add Vault-relative path(s) as removable context chips (same as @mention). */
	const attachContextPaths = useCallback(
		(rawPaths: string[]) => {
			const normalized = rawPaths
				.map((p) => toVaultRelative(vaultPath, p.trim()))
				.filter((p) => p.length > 0);
			if (!normalized.length) return;
			setMentionedPaths((prev) => [...new Set([...prev, ...normalized])]);
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
			// Clear an in-progress @ query so the menu closes after attach.
			setComposerText((prev) =>
				prev.replace(/(^|\s)@[^\s]*$/, (_match, prefix: string) => `${prefix}`),
			);
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
		setMentionedPaths((prev) => prev.filter((item) => item !== path));
	};

	// File tree "Add to chat" → drop paths as context chips (same as @-mention).
	// Handles same-window (module pub/sub) and the singleton feature window
	// (Tauri event). Consumes one pending batch on mount.
	useEffect(() => {
		const pending = takePendingAgentContextPaths();
		if (pending) attachContextPaths(pending);
		const unsubscribe = subscribePendingAgentContextPaths(attachContextPaths);
		let unlisten: (() => void) | undefined;
		void listenAgentAttachContext(attachContextPaths).then((u) => {
			unlisten = u;
		});
		return () => {
			unsubscribe();
			unlisten?.();
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

	const attachSkill = (skill: AgentSkill) => {
		setSelectedSkillIds((prev) => [...new Set([...prev, skill.id])]);
		setComposerMenuDismissed(true);
		setComposerText((prev) =>
			prev.replace(/(^|\s)\$[^\s]*$/, (_match, prefix: string) => `${prefix}`),
		);
	};

	const attachSlashCommand = useCallback(
		(command: AcpCommand) => {
			setComposerMenuDismissed(true);
			setComposerText((prev) =>
				prev.replace(
					/(^|\s)\/[^\s]*$/,
					(_match, prefix: string) => `${prefix}/${command.name} `,
				),
			);
		},
		[setComposerText],
	);

	const handleComposerMenuKeyDown = (
		event: KeyboardEvent<HTMLTextAreaElement>,
	) => {
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

		// ↑ / ↓ → walk previous user prompts into the composer (shell-style).
		// Does not open inline edit / rollback — Pencil still does that.
		if (switchingRef.current) return;
		const el = event.currentTarget;
		const isBrowsing = promptHistoryIndexRef.current !== null;
		const history = collectUserPromptTexts(
			lines,
			stripPromptEnvelopeForDisplay,
		);

		if (shouldNavigateHistoryUp(event, el, isBrowsing)) {
			if (history.length === 0) return;
			event.preventDefault();
			if (!isBrowsing) {
				promptHistoryDraftRef.current = el.value;
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
			placeCaretAtEnd(el, text);
			return;
		}

		if (shouldNavigateHistoryDown(event, el, isBrowsing)) {
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
				placeCaretAtEnd(el, draft);
				return;
			}
			const text = history[nextIndex] ?? "";
			promptHistoryIndexRef.current = nextIndex;
			promptHistoryAppliedRef.current = text;
			setComposerText(text);
			placeCaretAtEnd(el, text);
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
		},
		[
			promptHistoryAppliedRef,
			promptHistoryDraftRef,
			promptHistoryIndexRef,
			setComposerText,
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
		selectionChips,
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
		showSlashMenu,
		slashOptions,
		attachSlashCommand,
		attachContextPaths,
		handleComposerDragOver,
		handleComposerDrop,
		handleComposerMenuKeyDown,
		onComposerTextChangeFromUser,
	};
}
