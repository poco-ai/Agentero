import { lstat, stat } from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import { commands, type HtmlPreviewGrant } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import {
	basenameOf,
	dirnameOf,
	normalizeLocalPath,
	normalizePath,
} from "@/lib/core/path";
import { paperDirFromPath } from "@/lib/paper/detect";
import { findLocalPdfPath } from "@/lib/paper/media";
import { notesPathForPaper } from "@/lib/paper/paths";
import { fuzzyScore } from "@/lib/shell/commands/match";
import { readVaultBytes, readVaultFile } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";
import { isMarkdownPath } from "@/lib/vault/path-kinds";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { ensureLocalFsScope } from "@/lib/vault/scope";
import { getVaultPath, vaultStore } from "@/lib/vault/store";
import { isPathMissingError } from "@/lib/vault/tree";
import type { FileNode } from "@/lib/vault/types";
import type { WikiSearchCandidate } from "@/lib/wiki/api";
import { dockHandle } from "@/lib/workspace/dock-registry";
import { getActiveTab, getTabs } from "@/lib/workspace/store";
import { tabIsPaperNoteDocument } from "@/lib/workspace/tabs/notes-split";
import { isHtmlPath } from "@/lib/workspace/viewer";

export type SidebarFileData = {
	pdfBytes?: ArrayBuffer;
	markdown?: string;
	htmlGrant?: HtmlPreviewGrant;
};

export type SidebarFileTarget = {
	kind: "pdf" | "notes" | "html";
	vaultRelPath: string;
};

export function sidebarVaultRelative(
	vault: string,
	path: string,
): string | null {
	const root = normalizePath(vault);
	let relative = normalizePath(path);
	if (
		relative.startsWith("/") ||
		/^[a-z]:\//i.test(relative) ||
		relative.startsWith("remote:")
	) {
		const prefix = `${root}/`;
		const windows = /^[a-z]:\//i.test(root) || root.startsWith("//");
		if (
			!(windows
				? relative.toLowerCase().startsWith(prefix.toLowerCase())
				: relative.startsWith(prefix))
		)
			return null;
		relative = relative.slice(prefix.length);
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.includes("\0"))
		return null;
	const parts: string[] = [];
	for (const part of relative.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.join("/") || null;
}

export function sidebarFileTarget(
	vault: string,
	path: string,
): SidebarFileTarget | null {
	const vaultRelPath = sidebarVaultRelative(vault, path);
	if (!vaultRelPath) return null;
	if (/\.pdf$/i.test(vaultRelPath)) return { kind: "pdf", vaultRelPath };
	if (isHtmlPath(vaultRelPath)) return { kind: "html", vaultRelPath };
	if (isMarkdownPath(vaultRelPath)) return { kind: "notes", vaultRelPath };
	return null;
}

type SidebarFileResult = SidebarFileTarget & { label: string };

export function sidebarPaperTitle(
	vaultRelPath: string,
	papers: ReadonlyMap<string, { title: string }>,
): string | undefined {
	for (
		let folder = dirnameOf(vaultRelPath);
		folder;
		folder = dirnameOf(folder)
	) {
		const title = papers.get(folder)?.title.trim();
		if (title) return title;
	}
	return undefined;
}

export function collectSidebarSearchFiles(
	tree: FileNode[],
	vault: string,
	papers: ReadonlyMap<string, { title: string }>,
): SidebarFileResult[] {
	const files: SidebarFileResult[] = [];
	const visit = (nodes: FileNode[]) => {
		for (const node of nodes) {
			if (node.kind === "directory") {
				if (node.children) visit(node.children);
			} else {
				const target = sidebarFileTarget(vault, node.path);
				if (!target) continue;
				const name = basenameOf(target.vaultRelPath);
				const paperTitle =
					target.kind === "pdf" || /^notes\.md$/i.test(name)
						? sidebarPaperTitle(target.vaultRelPath, papers)
						: undefined;
				files.push({ ...target, label: paperTitle || name });
			}
		}
	};
	visit(tree);
	return files;
}

export function rankSidebarSearchFiles(
	vault: string,
	query: string,
	files: readonly SidebarFileResult[],
	wikiHits: readonly WikiSearchCandidate[],
): SidebarFileResult[] {
	if (!query.trim()) return [];
	const results = new Map<string, { file: SidebarFileResult; score: number }>();
	const add = (file: SidebarFileResult, score: number) => {
		if (score > (results.get(file.vaultRelPath)?.score ?? 0)) {
			results.set(file.vaultRelPath, { file, score });
		}
	};
	for (const file of files) {
		add(
			file,
			Math.max(
				fuzzyScore(query, file.label),
				fuzzyScore(query, file.vaultRelPath),
			),
		);
	}
	for (const hit of wikiHits) {
		if (hit.kind !== "file") continue;
		const target = sidebarFileTarget(vault, hit.path);
		if (target) {
			const labelScore = fuzzyScore(query, hit.label);
			add({ ...target, label: hit.label }, Math.max(1, labelScore));
		}
	}
	const exact = sidebarFileTarget(vault, query);
	if (
		exact &&
		(results.has(exact.vaultRelPath) || !results.size || /[/\\]/.test(query))
	) {
		add(
			results.get(exact.vaultRelPath)?.file ?? {
				...exact,
				label: basenameOf(exact.vaultRelPath),
			},
			Number.POSITIVE_INFINITY,
		);
	}
	return [...results.values()]
		.sort((left, right) => right.score - left.score)
		.slice(0, 6)
		.map(({ file }) => file);
}

export function currentSidebarPaperNotes(
	workspaceViewId?: string,
): string | undefined {
	const vault = getVaultPath();
	if (!vault) return;
	const visibleIds = dockHandle()?.visiblePanelIds();
	const focused =
		workspaceViewId && (!visibleIds || visibleIds.includes(workspaceViewId))
			? getTabs().find((tab) => tab.id === workspaceViewId)
			: undefined;
	const tab = focused ?? getActiveTab();
	const isPdf = tab?.mode === "pdf" || tab?.mode === "translation";
	if (tab && !isPdf && !tabIsPaperNoteDocument(tab)) return;
	const knownNotes =
		tab?.notesPath ??
		(tab?.paperMeta?.path ? notesPathForPaper(tab.paperMeta.path) : null);
	if (knownNotes) return sidebarVaultRelative(vault, knownNotes) ?? undefined;
	const path = tab?.path;
	if (!path) return;
	const paper = paperDirFromPath(path, vaultStore.getState().paperFolders);
	return paper
		? (sidebarVaultRelative(vault, notesPathForPaper(paper)) ?? undefined)
		: undefined;
}

export async function sidebarPaperPdf(
	vault: string,
	paperPath: string,
): Promise<SidebarFileTarget | null> {
	const relative = sidebarVaultRelative(vault, paperPath);
	if (!relative) return null;
	await ensureLocalFsScope(vault);
	const pdf = await findLocalPdfPath(joinVaultPath(vault, relative));
	return pdf ? sidebarFileTarget(vault, pdf) : null;
}

export async function sidebarPdfPageCount(
	content: ArrayBuffer,
): Promise<number> {
	const { withBackgroundPdfDocument } = await import(
		"@/lib/pdf/background-engine"
	);
	return withBackgroundPdfDocument(
		{ id: crypto.randomUUID(), content: content.slice(0) },
		undefined,
		async (_engine, document) => document.pageCount,
	);
}

export async function restoreSidebarFile(
	vault: string,
	target: SidebarFileTarget,
): Promise<SidebarFileTarget | null> {
	const normalized = sidebarFileTarget(vault, target.vaultRelPath);
	if (normalized?.kind !== target.kind) return null;
	const path = joinVaultPath(vault, normalized.vaultRelPath);
	if (isRemoteVaultHandle(vault)) return normalized;
	try {
		await ensureLocalFsScope(vault);
		const exists = (await stat(normalizeLocalPath(path))).isFile;
		return exists ? normalized : null;
	} catch (error) {
		return isPathMissingError(error) ? null : normalized;
	}
}

export async function readSidebarFile(
	vault: string,
	target: SidebarFileTarget,
	{ allowMissingNotes = false }: { allowMissingNotes?: boolean } = {},
): Promise<SidebarFileData> {
	const normalized = sidebarFileTarget(vault, target.vaultRelPath);
	if (normalized?.kind !== target.kind)
		throw new Error(i18n.t("app:sidebarTabs.unsupportedFile"));
	const path = joinVaultPath(vault, normalized.vaultRelPath);
	await ensureLocalFsScope(vault);
	if (target.kind !== "html" && !isRemoteVaultHandle(vault)) {
		let entry = vault;
		for (const segment of normalized.vaultRelPath.split("/")) {
			entry = joinVaultPath(entry, segment);
			const info = await lstat(normalizeLocalPath(entry)).catch(
				(error: unknown) => {
					if (
						allowMissingNotes &&
						target.kind === "notes" &&
						entry === path &&
						isPathMissingError(error)
					)
						return null;
					throw error;
				},
			);
			if (!info) return { markdown: "" };
			if (info.isSymlink) {
				throw new Error(i18n.t("app:sidebarTabs.unsupportedFile"));
			}
		}
	}
	switch (target.kind) {
		case "html":
			return {
				htmlGrant: await callApiResult(() =>
					commands.htmlPreviewGrant({ path }),
				),
			};
		case "notes":
			try {
				return { markdown: await readVaultFile(path) };
			} catch (error) {
				if (allowMissingNotes && isPathMissingError(error))
					return { markdown: "" };
				throw error;
			}
		case "pdf": {
			const bytes = await readVaultBytes(path);
			const buffer = bytes.buffer;
			return {
				pdfBytes:
					buffer instanceof ArrayBuffer &&
					bytes.byteLength === buffer.byteLength
						? buffer
						: new Uint8Array(bytes).buffer,
			};
		}
	}
}
