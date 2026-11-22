/**
 * Map a selected AlphaXiv library slice onto the magic-wand import pipeline.
 * Authenticated listing stays in the host; this module only sees arXiv ids
 * and public PDF URLs.
 */

import i18n from "@/i18n";
import { normalizeArxivId } from "@/lib/paper/arxiv";
import { enqueueLookup, enqueueLookupBatch } from "@/lib/paper/import-actions";
import { paperTagsChange } from "@/lib/paper/library-actions";
import { libraryStore } from "@/lib/paper/library-store";
import { loadPaperMetadata } from "@/lib/paper/load-meta";
import type { LookupAddResult, LookupBatchAddResult } from "@/lib/paper/lookup";
import { coercePaperTags } from "@/lib/paper/tags";
import type { PaperTag, PaperTagInput } from "@/lib/paper/types";
import { joinVaultPath } from "@/lib/vault";
import { getVaultPath } from "@/lib/vault/store";

export type AlphaXivImportSource = {
	folderName: string;
	arxivId: string;
	pdfUrl: string;
	title: string;
	importable: boolean;
};

export type AlphaXivImportPlanItem = {
	/** Bare arXiv id, version stripped, original case kept. */
	arxivId: string;
	pdfUrl: string;
	title: string;
	folderNames: string[];
};

export type AlphaXivBatchPaper = {
	id: string;
	path: string;
	title: string;
	paperDir: string;
	status?: "created" | "deduped" | "skipped";
};

export type AlphaXivBatchSnapshot = {
	imported: readonly AlphaXivBatchPaper[];
	skipped: readonly { raw: string; value: string; reason: string }[];
	errors: readonly string[];
};

export type AlphaXivItemOutcome =
	| { kind: "created"; paper: AlphaXivBatchPaper }
	| { kind: "existing"; paper?: AlphaXivBatchPaper }
	| { kind: "failed"; message: string };

export type AlphaXivImportSummary = {
	imported: number;
	skippedExisting: number;
	failed: number;
	failures: { title: string; message: string }[];
	/** Absolute folder of the first newly created paper, when there is one. */
	revealDir: string | null;
};

/** Bare arXiv id used as an import token. Empty when `raw` is not an arXiv id. */
export function bareArxivId(raw: string | null | undefined): string {
	return normalizeArxivId(raw ?? "")?.replace(/v\d+$/i, "") ?? "";
}

/** Case-folded key for library and batch matching. */
export function arxivMatchKey(raw: string | null | undefined): string {
	return bareArxivId(raw).toLowerCase();
}

export function libraryArxivIds(
	papers: readonly { arxiv_id?: string | null }[],
): Set<string> {
	const ids = new Set<string>();
	for (const paper of papers) {
		const key = arxivMatchKey(paper.arxiv_id);
		if (key) ids.add(key);
	}
	return ids;
}

/** One import per arXiv id. Folder names accumulate for the optional tag. */
export function planAlphaXivImport(
	rows: readonly AlphaXivImportSource[],
): AlphaXivImportPlanItem[] {
	const order: string[] = [];
	const byKey = new Map<string, AlphaXivImportPlanItem>();
	for (const row of rows) {
		if (!row.importable) continue;
		const arxivId = bareArxivId(row.arxivId);
		const key = arxivMatchKey(arxivId);
		if (!key) continue;
		let item = byKey.get(key);
		if (!item) {
			item = {
				arxivId,
				pdfUrl: row.pdfUrl.trim(),
				title: row.title.trim(),
				folderNames: [],
			};
			byKey.set(key, item);
			order.push(key);
		} else {
			if (!item.pdfUrl && row.pdfUrl.trim()) item.pdfUrl = row.pdfUrl.trim();
			if (!item.title && row.title.trim()) item.title = row.title.trim();
		}
		const folder = row.folderName.trim();
		if (
			folder &&
			!item.folderNames.some(
				(name) => name.toLocaleLowerCase() === folder.toLocaleLowerCase(),
			)
		) {
			item.folderNames.push(folder);
		}
	}
	return order.flatMap((key) => {
		const item = byKey.get(key);
		return item ? [item] : [];
	});
}

function paperMatchKeys(paper: AlphaXivBatchPaper): Set<string> {
	const keys = new Set<string>();
	const segment = paper.path.split(/[\\/]/).filter(Boolean).pop() ?? "";
	for (const candidate of [paper.id, segment]) {
		const direct = arxivMatchKey(candidate);
		if (direct) keys.add(direct);
		const folded = arxivMatchKey(candidate.replace(/_/g, "."));
		if (folded) keys.add(folded);
	}
	return keys;
}

function skipForToken(
	skipped: AlphaXivBatchSnapshot["skipped"],
	token: string,
): { reason: string } | undefined {
	const want = arxivMatchKey(token) || token.trim().toLowerCase();
	if (!want) return undefined;
	return skipped.find((item) => {
		const raw = arxivMatchKey(item.raw) || item.raw.trim().toLowerCase();
		const value = arxivMatchKey(item.value) || item.value.trim().toLowerCase();
		return raw === want || value === want || item.raw.trim() === token.trim();
	});
}

function errorForToken(errors: readonly string[], token: string): string {
	const prefix = `${token}:`;
	const lower = prefix.toLowerCase();
	return (
		errors.find(
			(error) =>
				error.startsWith(prefix) || error.toLowerCase().startsWith(lower),
		) ?? ""
	);
}

function outcomeFromPaper(paper: AlphaXivBatchPaper): AlphaXivItemOutcome {
	if (paper.status === "deduped" || paper.status === "skipped") {
		return { kind: "existing", paper };
	}
	return { kind: "created", paper };
}

/**
 * Pair a batch result with the arXiv ids that were submitted.
 * Papers the id/path cannot explain are returned for a catalog read.
 */
export function classifyAlphaXivBatch(
	items: readonly Pick<AlphaXivImportPlanItem, "arxivId">[],
	snapshot: AlphaXivBatchSnapshot,
): {
	outcomes: Map<string, AlphaXivItemOutcome>;
	unmatchedPapers: AlphaXivBatchPaper[];
} {
	const outcomes = new Map<string, AlphaXivItemOutcome>();
	const used = new Set<number>();
	for (const item of items) {
		const key = arxivMatchKey(item.arxivId);
		if (!key || outcomes.has(key)) continue;
		const skip = skipForToken(snapshot.skipped, item.arxivId);
		if (
			skip &&
			(skip.reason === "already_in_library" ||
				skip.reason === "duplicate_in_batch")
		) {
			outcomes.set(key, { kind: "existing" });
			continue;
		}
		if (skip) {
			outcomes.set(key, { kind: "failed", message: skip.reason });
			continue;
		}
		const message = errorForToken(snapshot.errors, item.arxivId);
		if (message) {
			outcomes.set(key, { kind: "failed", message });
			continue;
		}
		const index = snapshot.imported.findIndex(
			(paper, paperIndex) =>
				!used.has(paperIndex) && paperMatchKeys(paper).has(key),
		);
		const matched = index >= 0 ? snapshot.imported[index] : undefined;
		if (matched) {
			used.add(index);
			outcomes.set(key, outcomeFromPaper(matched));
			continue;
		}
		outcomes.set(key, { kind: "failed", message: "" });
	}
	const unmatchedPapers = snapshot.imported.filter(
		(_, index) => !used.has(index),
	);
	return { outcomes, unmatchedPapers };
}

/** One identifier or PDF URL. The batch result belongs to that single token. */
export function classifyAlphaXivToken(
	snapshot: AlphaXivBatchSnapshot,
): AlphaXivItemOutcome {
	const paper = snapshot.imported[0];
	if (paper) return outcomeFromPaper(paper);
	const skip = snapshot.skipped[0];
	if (
		skip &&
		(skip.reason === "already_in_library" ||
			skip.reason === "duplicate_in_batch")
	) {
		return { kind: "existing" };
	}
	return {
		kind: "failed",
		message: snapshot.errors.find(Boolean) || skip?.reason || "",
	};
}

export function mergeFolderTags(
	existing: readonly PaperTagInput[],
	folderNames: readonly string[],
): PaperTag[] {
	const next = coercePaperTags(existing);
	const seen = new Set(next.map((tag) => tag.name.toLocaleLowerCase()));
	for (const raw of folderNames) {
		const name = raw.trim();
		if (!name) continue;
		const key = name.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		next.push({ name });
	}
	return next;
}

function sameTags(
	existing: readonly PaperTagInput[],
	next: readonly PaperTag[],
): boolean {
	const current = coercePaperTags(existing);
	if (current.length !== next.length) return false;
	return current.every(
		(tag, index) =>
			tag.name === next[index]?.name &&
			(tag.color ?? null) === (next[index]?.color ?? null),
	);
}

function toBatchPaper(paper: LookupAddResult): AlphaXivBatchPaper {
	return {
		id: paper.id,
		path: paper.path,
		title: paper.title,
		paperDir: paper.paperDir,
		status: paper.status,
	};
}

function toSnapshot(result: LookupBatchAddResult): AlphaXivBatchSnapshot {
	return {
		imported: result.imported.map(toBatchPaper),
		skipped: result.skipped,
		errors: result.errors,
	};
}

function absolutePaperDir(
	vaultPath: string,
	paper: AlphaXivBatchPaper | undefined,
): string {
	if (!paper) return "";
	const dir = paper.paperDir.trim();
	if (dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)) return dir;
	const rel = paper.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return rel ? joinVaultPath(vaultPath, rel) : dir;
}

async function applyFolderTags(
	vaultPath: string,
	paper: AlphaXivBatchPaper | undefined,
	arxivId: string,
	folderNames: readonly string[],
): Promise<void> {
	if (folderNames.length === 0) return;
	let meta = paper
		? await loadPaperMetadata(absolutePaperDir(vaultPath, paper), vaultPath)
		: null;
	if (!meta) {
		const key = arxivMatchKey(arxivId);
		meta =
			libraryStore
				.getState()
				.papers.find((row) => arxivMatchKey(row.arxiv_id) === key) ?? null;
	}
	if (!meta?.path) return;
	const next = mergeFolderTags(meta.tags ?? [], folderNames);
	if (sameTags(meta.tags ?? [], next)) return;
	await paperTagsChange(meta, next);
}

async function upgradeUnmatched(
	vaultPath: string,
	outcomes: Map<string, AlphaXivItemOutcome>,
	unmatched: readonly AlphaXivBatchPaper[],
): Promise<void> {
	for (const paper of unmatched) {
		const meta = await loadPaperMetadata(
			absolutePaperDir(vaultPath, paper),
			vaultPath,
		);
		const key = arxivMatchKey(meta?.arxiv_id);
		if (!key) continue;
		const current = outcomes.get(key);
		if (current?.kind !== "failed") continue;
		outcomes.set(key, outcomeFromPaper(paper));
	}
}

async function importTokens(
	tokens: string[],
): Promise<LookupBatchAddResult | null> {
	if (tokens.length === 0) return null;
	let captured: LookupBatchAddResult | null = null;
	const queued = await enqueueLookupBatch(tokens, {
		onComplete: (result) => {
			captured = result;
		},
	});
	if (!queued) return null;
	await queued.settled;
	return captured;
}

async function importOneToken(token: string): Promise<AlphaXivItemOutcome> {
	let captured: LookupBatchAddResult | null = null;
	const queued = await enqueueLookup([token], {
		onComplete: (result) => {
			captured = result;
		},
	});
	await queued.settled;
	if (!captured) return { kind: "failed", message: "" };
	return classifyAlphaXivToken(toSnapshot(captured));
}

/**
 * Import the planned papers through the identifier batch pipeline.
 * An arXiv id that fails is retried once with the AlphaXiv PDF URL.
 * Folder tags are added onto the current tag list.
 */
export async function importAlphaXivPlan(
	items: readonly AlphaXivImportPlanItem[],
	opts: { tagFolders: boolean },
): Promise<AlphaXivImportSummary> {
	const summary: AlphaXivImportSummary = {
		imported: 0,
		skippedExisting: 0,
		failed: 0,
		failures: [],
		revealDir: null,
	};
	if (items.length === 0) return summary;
	const vaultPath = getVaultPath();
	if (!vaultPath) throw new Error(i18n.t("sidebar:alphaxivImport.noVault"));

	const batch = await importTokens(items.map((item) => item.arxivId));
	if (!batch) throw new Error(i18n.t("sidebar:alphaxivImport.importFailed"));
	const classified = classifyAlphaXivBatch(items, toSnapshot(batch));
	await upgradeUnmatched(
		vaultPath,
		classified.outcomes,
		classified.unmatchedPapers,
	);

	for (const item of items) {
		const key = arxivMatchKey(item.arxivId);
		let outcome = classified.outcomes.get(key) ?? {
			kind: "failed" as const,
			message: "",
		};
		if (outcome.kind === "failed" && item.pdfUrl) {
			const retried = await importOneToken(item.pdfUrl);
			if (retried.kind !== "failed") outcome = retried;
			else if (retried.message) outcome = retried;
		}
		const title = item.title || item.arxivId;
		if (outcome.kind === "failed") {
			summary.failed += 1;
			summary.failures.push({ title, message: outcome.message });
			continue;
		}
		if (outcome.kind === "created") summary.imported += 1;
		else summary.skippedExisting += 1;
		if (outcome.kind === "created" && !summary.revealDir && outcome.paper) {
			const dir = absolutePaperDir(vaultPath, outcome.paper);
			if (dir) summary.revealDir = dir;
		}
		if (!opts.tagFolders) continue;
		try {
			await applyFolderTags(
				vaultPath,
				outcome.paper,
				item.arxivId,
				item.folderNames,
			);
		} catch {
			// paperTagsChange already reports a tag write failure.
		}
	}
	return summary;
}

/** Stable row id for a paper inside one folder. */
export function alphaXivPaperId(paper: {
	paperGroupId: string;
	arxivId: string;
	canonicalId: string;
	title: string;
	index: number;
}): string {
	return (
		paper.paperGroupId ||
		paper.arxivId ||
		paper.canonicalId ||
		paper.title ||
		String(paper.index)
	);
}

export function alphaXivRowKey(folderId: string, paperId: string): string {
	return `${folderId}\u0000${paperId}`;
}

export function formatAlphaXivAddedAt(raw: string): string {
	const text = raw.trim();
	if (!text) return "";
	if (/^\d{11,}$/.test(text)) {
		const date = new Date(Number(text));
		return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
	}
	if (/^\d{10}$/.test(text)) {
		const date = new Date(Number(text) * 1000);
		return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
	}
	const parsed = Date.parse(text);
	if (!Number.isNaN(parsed) && text.length >= 10) return text.slice(0, 10);
	return text;
}
