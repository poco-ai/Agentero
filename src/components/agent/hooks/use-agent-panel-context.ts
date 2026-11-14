/**
 * Shared cross-cutting state for the Agent panel sub-hooks: race-guard refs,
 * pending-event maps, derived Vault context paths, and the session-context
 * reset used by vault switch / agent switch.
 */

import type { TFunction } from "i18next";
import { type RefObject, useCallback, useMemo, useRef } from "react";
import type { UseAgentPanelArgs } from "@/components/agent/types";
import type {
	ChatSessionHistoryItem,
	PendingSessionEvent,
	PendingTerminalEvent,
} from "@/lib/agent/chat-state";
import {
	type ContextPathLabelOptions,
	contextPathLabel,
	normalizeContextPath,
	paperContextRoot,
	toPathSet,
} from "@/lib/agent/context-path-icon";
import type { ThinkTagParser } from "@/lib/agent/stream-parse";
import { isZenVirtualPath } from "@/lib/agent/zen-path";
import type { PaperMetadata } from "@/lib/paper";
import { paperDirFromPath } from "@/lib/paper";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { isPlazaVirtualPath } from "@/lib/plaza/sources";
import { toVaultRelative } from "@/lib/wiki";

/** Translate fn scoped to the `agent` i18n namespace (shared by sub-hooks). */
export type AgentPanelT = TFunction<"agent", undefined>;

export type AgentPanelRefs = {
	activeConversationRef: RefObject<string | null>;
	activeTabRef: RefObject<string>;
	selectedAgentIdRef: RefObject<string | null>;
	switchingRef: RefObject<boolean>;
	/**
	 * Submitting flag mirror for synchronous guards in event callbacks.
	 * Write only through the panel's `setSubmittingFlag` so ref + render
	 * state stay in lockstep.
	 */
	submittingRef: RefObject<boolean>;
	submissionGenRef: RefObject<number>;
	sessionContextGenRef: RefObject<number>;
	historyGenRef: RefObject<number>;
	historyHydrationGenRef: RefObject<number>;
	pendingTerminalEventsRef: RefObject<Map<string, PendingTerminalEvent>>;
	pendingSessionEventsRef: RefObject<Map<string, PendingSessionEvent[]>>;
	pendingSubmissionSessionIdRef: RefObject<string | null>;
	knownSessionIdsRef: RefObject<Set<string>>;
	thinkParsersRef: RefObject<Map<string, ThinkTagParser>>;
	sessionHistoryRef: RefObject<ChatSessionHistoryItem[]>;
	vaultPathRef: RefObject<string | null>;
	promptHistoryIndexRef: RefObject<number | null>;
	promptHistoryDraftRef: RefObject<string>;
	promptHistoryAppliedRef: RefObject<string | null>;
};

export type AgentPanelContext = {
	/** Focused document as Vault-relative context path (paper folder minimum). */
	selectedVaultPath: string | null;
	/**
	 * Catalog metadata for the focused paper, when the focus is a paper and the
	 * catalog knows it. Used as public context for chat-only agents that cannot
	 * read Vault files.
	 */
	selectedPaperMeta: PaperMetadata | null;
	directoryPathSet: ReadonlySet<string>;
	paperPathSet: ReadonlySet<string>;
	pathLabelOptions: ContextPathLabelOptions;
	labelForPath: (path: string) => string;
	mentionLabelsByPath: Map<string, string>;
	refs: AgentPanelRefs;
	/**
	 * Invalidate the shared session context (gens, pending events, known ids,
	 * think parsers). Vault switch additionally resets submission state.
	 */
	resetSessionContext: () => void;
};

export function useAgentPanelContext({
	vaultPath,
	selectedPath = null,
	vaultDirectoryPaths = [],
	vaultPaperPaths = [],
	paperMetaByRelPath = null,
	paperTreeLabelMode = "title-author",
}: UseAgentPanelArgs): AgentPanelContext {
	/**
	 * Focused document as Vault-relative context path.
	 * Files under a paper resolve to the **paper folder** (minimal unit).
	 */
	const selectedVaultPath = useMemo(() => {
		if (!selectedPath) return null;
		if (
			isLibraryVirtualPath(selectedPath) ||
			isTrashVirtualPath(selectedPath) ||
			isZenVirtualPath(selectedPath) ||
			// Plaza tabs are virtual; with the whole-list collection a focused
			// Daily tab must not silently inject the full abstract catalog
			// into every prompt — plaza context is explicit `@` only.
			isPlazaVirtualPath(selectedPath)
		) {
			return null;
		}
		const relative = toVaultRelative(vaultPath, selectedPath);
		if (!relative) return null;
		if (
			isLibraryVirtualPath(relative) ||
			isTrashVirtualPath(relative) ||
			isZenVirtualPath(relative) ||
			isPlazaVirtualPath(relative)
		) {
			return null;
		}
		const paperDir = paperDirFromPath(relative, vaultPaperPaths);
		return paperDir ?? relative;
	}, [selectedPath, vaultPath, vaultPaperPaths]);
	/**
	 * Catalog metadata for the focused paper (chat-only agent context). Only
	 * resolved when the focus maps to a known paper folder — a plain note or
	 * virtual tab yields null.
	 */
	const selectedPaperMeta = useMemo(() => {
		if (!paperMetaByRelPath || !selectedVaultPath) return null;
		const root = paperContextRoot(selectedVaultPath, vaultPaperPaths);
		if (!root) return null;
		return paperMetaByRelPath.get(root) ?? null;
	}, [paperMetaByRelPath, selectedVaultPath, vaultPaperPaths]);

	/** O(1) lookups for context chip icons (paper → ScrollText, dir → Folder). */
	const directoryPathSet = useMemo(
		() => toPathSet(vaultDirectoryPaths),
		[vaultDirectoryPaths],
	);
	const paperPathSet = useMemo(
		() => toPathSet(vaultPaperPaths),
		[vaultPaperPaths],
	);

	/** Label options shared by chips and @ menu (matches file-tree settings). */
	const pathLabelOptions = useMemo(
		() => ({
			paperPaths: paperPathSet,
			paperMetaByRelPath,
			paperTreeLabelMode,
		}),
		[paperMetaByRelPath, paperPathSet, paperTreeLabelMode],
	);

	const labelForPath = useCallback(
		(path: string) => contextPathLabel(path, pathLabelOptions),
		[pathLabelOptions],
	);

	/** Searchable labels for @ filter (paper titles, not only folder names). */
	const mentionLabelsByPath = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of vaultPaperPaths) {
			const label = contextPathLabel(p, pathLabelOptions);
			if (label && label !== p) map.set(normalizeContextPath(p), label);
		}
		return map;
	}, [pathLabelOptions, vaultPaperPaths]);

	const activeConversationRef = useRef<string | null>(null);
	const activeTabRef = useRef("draft");
	const selectedAgentIdRef = useRef<string | null>(null);
	const switchingRef = useRef(false);
	const submittingRef = useRef(false);
	const submissionGenRef = useRef(0);
	const sessionContextGenRef = useRef(0);
	const historyGenRef = useRef(0);
	const historyHydrationGenRef = useRef(0);
	const pendingTerminalEventsRef = useRef(
		new Map<string, PendingTerminalEvent>(),
	);
	const pendingSessionEventsRef = useRef(
		new Map<string, PendingSessionEvent[]>(),
	);
	/** Runtime id awaiting publication; never the provider id used for resume. */
	const pendingSubmissionSessionIdRef = useRef<string | null>(null);
	const knownSessionIdsRef = useRef(new Set<string>());
	/** Per-session <think> tag parsers for message-channel reasoning (DeepSeek etc.). */
	const thinkParsersRef = useRef(new Map<string, ThinkTagParser>());
	const sessionHistoryRef = useRef<ChatSessionHistoryItem[]>([]);
	const vaultPathRef = useRef(vaultPath);
	/**
	 * ↑/↓ prompt history: index into chronological user prompts, or null when
	 * not browsing. Draft is restored when stepping past the newest entry.
	 */
	const promptHistoryIndexRef = useRef<number | null>(null);
	const promptHistoryDraftRef = useRef("");
	const promptHistoryAppliedRef = useRef<string | null>(null);

	const refs: AgentPanelRefs = {
		activeConversationRef,
		activeTabRef,
		selectedAgentIdRef,
		switchingRef,
		submittingRef,
		submissionGenRef,
		sessionContextGenRef,
		historyGenRef,
		historyHydrationGenRef,
		pendingTerminalEventsRef,
		pendingSessionEventsRef,
		pendingSubmissionSessionIdRef,
		knownSessionIdsRef,
		thinkParsersRef,
		sessionHistoryRef,
		vaultPathRef,
		promptHistoryIndexRef,
		promptHistoryDraftRef,
		promptHistoryAppliedRef,
	};

	const resetSessionContext = useCallback(() => {
		sessionContextGenRef.current += 1;
		historyGenRef.current += 1;
		historyHydrationGenRef.current += 1;
		pendingTerminalEventsRef.current.clear();
		pendingSessionEventsRef.current.clear();
		pendingSubmissionSessionIdRef.current = null;
		knownSessionIdsRef.current.clear();
		thinkParsersRef.current.clear();
	}, []);

	return {
		selectedVaultPath,
		selectedPaperMeta,
		directoryPathSet,
		paperPathSet,
		pathLabelOptions,
		labelForPath,
		mentionLabelsByPath,
		refs,
		resetSessionContext,
	};
}
