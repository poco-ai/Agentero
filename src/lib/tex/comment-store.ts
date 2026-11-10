/**
 * Review comments for TeX sources. Stored in the vault's `.agentero`
 * directory, which the file tree already hides, so they never reach latexmk.
 */

import type { ChangeSet } from "@codemirror/state";
import { createStore } from "zustand/vanilla";
import { normalizePath } from "@/lib/core/path";
import {
	attachComment,
	commentContext,
	shiftComment,
	type TexComment,
	type TexCommentMessage,
} from "@/lib/tex/comments";
import { readVaultFile, writeVaultFile } from "@/lib/vault/fs";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";

type TexCommentFile = {
	version: 1;
	threads: TexComment[];
};

type TexCommentState = {
	threads: TexComment[];
};

export const texCommentStore = createStore<TexCommentState>(() => ({
	threads: [],
}));

const FILE_NAME = ".agentero/tex-comments.json";
let loadedVault = "";
let loading: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function commentFileKey(path: string): string {
	const vault = getVaultPath();
	if (vault) {
		const relative = vaultRelativePath(vault, path);
		if (relative) return normalizePath(relative);
	}
	return normalizePath(path);
}

function commentId(): string {
	return crypto.randomUUID();
}

function sameAnchor(left: TexComment, right: TexComment): boolean {
	return (
		left.from === right.from &&
		left.to === right.to &&
		left.quote === right.quote &&
		left.detached === right.detached &&
		left.prefix === right.prefix &&
		left.suffix === right.suffix
	);
}

function replaceThreads(threads: TexComment[]): void {
	texCommentStore.setState({ threads });
	schedulePersist();
}

export function loadTexComments(): Promise<void> {
	const vault = getVaultPath();
	if (!vault) return Promise.resolve();
	const key = normalizePath(vault);
	if (loadedVault === key) return Promise.resolve();
	if (loading) return loading;
	loading = (async () => {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		let threads: TexComment[] = [];
		try {
			const text = await readVaultFile(joinVaultPath(vault, FILE_NAME));
			const parsed = JSON.parse(text) as TexCommentFile;
			if (parsed.version === 1 && Array.isArray(parsed.threads)) {
				threads = parsed.threads.filter(isTexComment);
			}
		} catch {
			threads = [];
		}
		loadedVault = key;
		texCommentStore.setState({ threads });
	})().finally(() => {
		loading = null;
	});
	return loading;
}

export function addTexComment(
	file: string,
	doc: string,
	from: number,
	to: number,
	body: string,
): TexComment | null {
	const text = body.trim();
	const anchor = commentContext(doc, from, to);
	if (!text || !anchor.quote.trim()) return null;
	const now = Date.now();
	const thread: TexComment = {
		id: commentId(),
		file,
		...anchor,
		detached: false,
		resolved: false,
		createdAt: now,
		messages: [{ id: commentId(), body: text, at: now }],
	};
	replaceThreads([...texCommentStore.getState().threads, thread]);
	return thread;
}

export function replyTexComment(threadId: string, body: string): void {
	const text = body.trim();
	if (!text) return;
	const message: TexCommentMessage = {
		id: commentId(),
		body: text,
		at: Date.now(),
	};
	replaceThreads(
		texCommentStore
			.getState()
			.threads.map((thread) =>
				thread.id === threadId
					? { ...thread, messages: [...thread.messages, message] }
					: thread,
			),
	);
}

export function editTexComment(
	threadId: string,
	messageId: string,
	body: string,
): void {
	const text = body.trim();
	if (!text) return;
	replaceThreads(
		texCommentStore.getState().threads.map((thread) =>
			thread.id === threadId
				? {
						...thread,
						messages: thread.messages.map((message) =>
							message.id === messageId ? { ...message, body: text } : message,
						),
					}
				: thread,
		),
	);
}

export function deleteTexComment(threadId: string, messageId: string): void {
	replaceThreads(
		texCommentStore.getState().threads.flatMap((thread) => {
			if (thread.id !== threadId) return [thread];
			if (thread.messages[0]?.id === messageId) return [];
			return [
				{
					...thread,
					messages: thread.messages.filter(
						(message) => message.id !== messageId,
					),
				},
			];
		}),
	);
}

export function resolveTexComment(threadId: string, resolved: boolean): void {
	replaceThreads(
		texCommentStore
			.getState()
			.threads.map((thread) =>
				thread.id === threadId ? { ...thread, resolved } : thread,
			),
	);
}

export function shiftTexComments(
	file: string,
	changes: ChangeSet,
	nextDoc: string,
): void {
	let changed = false;
	const threads = texCommentStore.getState().threads.map((thread) => {
		if (thread.file !== file) return thread;
		const next = shiftComment(thread, changes, nextDoc);
		if (!sameAnchor(thread, next)) changed = true;
		return next;
	});
	if (!changed) return;
	texCommentStore.setState({ threads });
	schedulePersist();
}

export function relocateTexComments(file: string, doc: string): void {
	let changed = false;
	const threads = texCommentStore.getState().threads.map((thread) => {
		if (thread.file !== file) return thread;
		const next = attachComment(doc, thread);
		if (!sameAnchor(thread, next)) changed = true;
		return next;
	});
	if (!changed) return;
	texCommentStore.setState({ threads });
	schedulePersist();
}

function schedulePersist(): void {
	const vault = getVaultPath();
	if (!vault) return;
	const key = normalizePath(vault);
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		if (normalizePath(getVaultPath() ?? "") !== key) return;
		const payload: TexCommentFile = {
			version: 1,
			threads: texCommentStore.getState().threads,
		};
		void writeVaultFile(
			joinVaultPath(vault, FILE_NAME),
			JSON.stringify(payload),
		).catch(() => {
			// The editor keeps the in-memory threads if the sidecar cannot be written.
		});
	}, 300);
}

function isTexComment(value: unknown): value is TexComment {
	if (!value || typeof value !== "object") return false;
	const thread = value as TexComment;
	return (
		typeof thread.id === "string" &&
		typeof thread.file === "string" &&
		typeof thread.quote === "string" &&
		Array.isArray(thread.messages)
	);
}
