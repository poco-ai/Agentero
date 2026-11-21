/**
 * PDF visual-region drafts for the Agent composer (ephemeral).
 * One bucket per composer session, so the same mark can sit unsent in two
 * sessions without sharing a crop. Not persisted — consumed on submit,
 * independent of the text selection store.
 */

import { createStore } from "zustand/vanilla";

import type { PromptImage } from "@/lib/agent/api";
import { toVaultRelative } from "@/lib/core/path";
import { newTraceId } from "@/lib/pdf-visual/ids";
import type { PdfVisualNormalizedRect } from "@/lib/pdf-visual/types";
import { vaultStore } from "@/lib/vault/store";

export type PdfVisualDraft = {
	id: string;
	/** Vault-relative paper path when known. */
	paperPath: string;
	/** Absolute paper path for crop/write helpers at runtime only. */
	paperAbsPath?: string;
	/** 1-based PDF page number. */
	page: number;
	rects: PdfVisualNormalizedRect[];
	comment: string;
	/** Crop used for composer thumbnails and runOnce images. */
	image: PromptImage;
};

type VisualContextStore = {
	/** `${scopeKey}\\n${sessionId}` of the composer currently on screen. */
	activeKey: string;
	/** Drafts for `activeKey`, in insertion order. */
	drafts: PdfVisualDraft[];
};

const MAX_DRAFTS = 12;
const MAX_COMMENT_CHARS = 2000;
const EMPTY_DRAFTS: PdfVisualDraft[] = [];
const NO_IDS: readonly string[] = [];

const buckets = new Map<string, PdfVisualDraft[]>();
/** Mark ids `addVisualDraft` still needs the matching composer to show. */
const pendingByKey = new Map<string, string[]>();

export const visualContextStore = createStore<VisualContextStore>(() => ({
	activeKey: "",
	drafts: EMPTY_DRAFTS,
}));

/** Bucket key shared with the composer identity string. */
export function visualDraftSessionKey(
	scopeKey: string | null,
	sessionId: string,
): string {
	return `${scopeKey ?? ""}\n${sessionId}`;
}

export function activeVisualDraftSessionKey(): string {
	return visualContextStore.getState().activeKey;
}

function bucketOf(key: string): PdfVisualDraft[] {
	return buckets.get(key) ?? EMPTY_DRAFTS;
}

function commitBucket(key: string, drafts: PdfVisualDraft[]): void {
	const next = drafts.length === 0 ? EMPTY_DRAFTS : drafts;
	if (next === EMPTY_DRAFTS) buckets.delete(key);
	else buckets.set(key, next);
	if (visualContextStore.getState().activeKey !== key) return;
	if (visualContextStore.getState().drafts === next) return;
	visualContextStore.setState({ drafts: next });
}

function mergeDrafts(
	base: readonly PdfVisualDraft[],
	incoming: readonly PdfVisualDraft[],
): PdfVisualDraft[] {
	const next = [...base];
	for (const draft of incoming) {
		const index = next.findIndex((item) => item.id === draft.id);
		if (index >= 0) next[index] = draft;
		else next.push(draft);
	}
	return next.slice(-MAX_DRAFTS);
}

function queueVisualInsert(key: string, id: string): void {
	const list = pendingByKey.get(key);
	if (list?.includes(id)) return;
	pendingByKey.set(key, list ? [...list, id] : [id]);
}

function movePending(fromKey: string, toKey: string): void {
	const incoming = pendingByKey.get(fromKey);
	if (!incoming?.length) return;
	const next = [...(pendingByKey.get(toKey) ?? [])];
	for (const id of incoming) {
		if (!next.includes(id)) next.push(id);
	}
	pendingByKey.set(toKey, next);
	pendingByKey.delete(fromKey);
}

/**
 * Drafts added before any composer was mounted live in the unbound bucket.
 * The first real session adopts them.
 */
function absorbUnboundBucket(key: string): void {
	const unbound = buckets.get("");
	if (unbound?.length) {
		commitBucket(key, mergeDrafts(bucketOf(key), unbound));
		buckets.delete("");
	}
	movePending("", key);
}

/** Replace one session's unsent visual drafts (cross-window handoff seed). */
export function seedVisualDraftSession(
	key: string,
	drafts: readonly PdfVisualDraft[],
): void {
	commitBucket(
		key,
		drafts.length === 0 ? EMPTY_DRAFTS : [...drafts].slice(-MAX_DRAFTS),
	);
}

/** Show this session's drafts. Other sessions' buckets stay where they are. */
export function activateVisualDraftSession(key: string): void {
	if (key !== "" && visualContextStore.getState().activeKey === "") {
		absorbUnboundBucket(key);
	}
	const drafts = bucketOf(key);
	const state = visualContextStore.getState();
	if (state.activeKey === key && state.drafts === drafts) return;
	visualContextStore.setState({ activeKey: key, drafts });
}

/** Drop one session's unsent crops, usually because its composer was reset. */
export function clearVisualDraftSession(key: string): void {
	pendingByKey.delete(key);
	commitBucket(key, EMPTY_DRAFTS);
}

/**
 * The open composer changed id (draft → runtime session) and took its text
 * with it. Move that session's crops too.
 */
export function rebindVisualDraftSession(fromKey: string, toKey: string): void {
	if (fromKey === toKey) {
		activateVisualDraftSession(toKey);
		return;
	}
	const incoming = buckets.get(fromKey);
	if (incoming?.length) {
		commitBucket(toKey, mergeDrafts(bucketOf(toKey), incoming));
		buckets.delete(fromKey);
	}
	movePending(fromKey, toKey);
	activateVisualDraftSession(toKey);
}

function normalizeComment(comment: string): string {
	return comment.trim().slice(0, MAX_COMMENT_CHARS);
}

function resolvePaperPath(sourcePath: string): string {
	return toVaultRelative(vaultStore.getState().vaultPath, sourcePath);
}

/**
 * Add a visual annotation draft to the active session. A draft id is the mark
 * id, so one mark is at most one entry in that session: re-adding refreshes
 * it in place. Another session keeps its own copy.
 */
export function addVisualDraft(input: {
	paperPath: string;
	paperAbsPath?: string;
	page: number;
	rects: PdfVisualNormalizedRect[];
	comment?: string;
	image: PromptImage;
	id?: string;
}): PdfVisualDraft {
	const draft: PdfVisualDraft = {
		// Existing marks pass their id. Sending uses the crop as prompt context
		// and does not rewrite marks/<id>.json.
		id: input.id ?? newTraceId(),
		paperPath: resolvePaperPath(input.paperPath),
		page: Math.max(1, Math.floor(input.page)),
		rects: input.rects,
		comment: normalizeComment(input.comment ?? ""),
		image: {
			data: input.image.data,
			mimeType: input.image.mimeType || "image/png",
		},
	};
	if (input.paperAbsPath?.trim()) {
		draft.paperAbsPath = input.paperAbsPath.trim();
	}
	const key = visualContextStore.getState().activeKey;
	const drafts = bucketOf(key);
	const existing = drafts.findIndex((item) => item.id === draft.id);
	queueVisualInsert(key, draft.id);
	commitBucket(
		key,
		existing >= 0
			? drafts.map((item, index) => (index === existing ? draft : item))
			: [...drafts, draft].slice(-MAX_DRAFTS),
	);
	return draft;
}

/** Update comment text for a draft in the active session. */
export function updateVisualDraftComment(id: string, comment: string): boolean {
	const key = visualContextStore.getState().activeKey;
	const drafts = bucketOf(key);
	const index = drafts.findIndex((item) => item.id === id);
	if (index < 0) return false;
	const next = [...drafts];
	next[index] = { ...next[index], comment: normalizeComment(comment) };
	commitBucket(key, next);
	return true;
}

/** Remove one draft from the active session. */
export function removeVisualDraft(id: string): void {
	const key = visualContextStore.getState().activeKey;
	const drafts = bucketOf(key);
	if (!drafts.some((item) => item.id === id)) return;
	commitBucket(
		key,
		drafts.filter((item) => item.id !== id),
	);
}

/** Active session's drafts, in insertion order. */
export function currentVisualDrafts(): PdfVisualDraft[] {
	return visualContextStore.getState().drafts;
}

/** Drafts stored for one session, whether or not it is on screen. */
export function visualDraftsForSession(sessionKey: string): PdfVisualDraft[] {
	if (sessionKey === visualContextStore.getState().activeKey) {
		return visualContextStore.getState().drafts;
	}
	return bucketOf(sessionKey);
}

/** Ids from `addVisualDraft` that this session's composer still needs to show. */
export function pendingVisualInsertIds(
	sessionKey = visualContextStore.getState().activeKey,
): readonly string[] {
	return pendingByKey.get(sessionKey) ?? NO_IDS;
}

/**
 * Drop requests that are already in the composer text, or whose draft is gone.
 * Requests still waiting to be inserted stay queued for that session.
 */
export function forgetVisualInsertRequests(
	sessionKey: string,
	textIds: readonly string[],
	storeIds: readonly string[],
): void {
	const list = pendingByKey.get(sessionKey);
	if (!list) return;
	const inText = new Set(textIds);
	const inStore = new Set(storeIds);
	const next = list.filter((id) => inStore.has(id) && !inText.has(id));
	if (next.length === 0) pendingByKey.delete(sessionKey);
	else pendingByKey.set(sessionKey, next);
}

/** Snapshot and clear the active session — a submitted turn consumes its drafts. */
export function consumeVisualDrafts(): PdfVisualDraft[] {
	const key = visualContextStore.getState().activeKey;
	pendingByKey.delete(key);
	const all = bucketOf(key);
	if (all.length) commitBucket(key, EMPTY_DRAFTS);
	return all;
}

/**
 * Remove these ids from one session and return them in `ids` order.
 * Defaults to the active session. Other sessions keep their own copies.
 */
export function takeVisualDrafts(
	ids: readonly string[],
	sessionKey = visualContextStore.getState().activeKey,
): PdfVisualDraft[] {
	if (ids.length === 0) return [];
	const drafts = bucketOf(sessionKey);
	const byId = new Map(drafts.map((draft) => [draft.id, draft]));
	const taken: PdfVisualDraft[] = [];
	const remove = new Set<string>();
	for (const id of ids) {
		if (remove.has(id)) continue;
		const draft = byId.get(id);
		if (!draft) continue;
		taken.push(draft);
		remove.add(id);
	}
	if (remove.size === 0) return [];
	const pending = pendingByKey.get(sessionKey);
	if (pending) {
		const next = pending.filter((id) => !remove.has(id));
		if (next.length === 0) pendingByKey.delete(sessionKey);
		else pendingByKey.set(sessionKey, next);
	}
	commitBucket(
		sessionKey,
		drafts.filter((draft) => !remove.has(draft.id)),
	);
	return taken;
}

/** Drop every session's drafts without consuming. */
export function clearVisualDrafts(): void {
	buckets.clear();
	pendingByKey.clear();
	if (visualContextStore.getState().drafts === EMPTY_DRAFTS) return;
	visualContextStore.setState({ drafts: EMPTY_DRAFTS });
}

/**
 * Group drafts by paperPath for per-paper trace writes that still share
 * one Agent session.
 */
export function groupVisualDraftsByPaper(
	drafts: PdfVisualDraft[],
): Map<string, PdfVisualDraft[]> {
	const groups = new Map<string, PdfVisualDraft[]>();
	for (const draft of drafts) {
		const key = draft.paperPath || draft.paperAbsPath || "";
		const list = groups.get(key) ?? [];
		list.push(draft);
		groups.set(key, list);
	}
	return groups;
}
