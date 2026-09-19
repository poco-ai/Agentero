/**
 * Vault-external full-text scratch copies for @-mentioned plaza papers.
 *
 * The Host downloads the arXiv PDF into `<cache>/agentero/plaza-scratch/` and
 * converts it to markdown (same liteparse engine as Vault papers), so the
 * Agent reads full text without anything entering the Vault. Preparation is
 * best-effort: failures degrade to abstract-only prompt context.
 */

import { plazaMentionArxivId } from "@/lib/agent/plaza-mention";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";

const PREPARE_TIMEOUT_MS = 60_000;

export type PlazaScratchStats = { papers: number; bytes: number };
export type PlazaScratchClearResult = { freedBytes: number };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Prepare scratch full texts for the given mention paths. Returns
 * mention path → absolute markdown path for every paper that succeeded;
 * always resolves (never throws) — the prompt falls back to abstracts.
 */
export async function preparePlazaScratch(
	plazaPaths: readonly string[],
): Promise<Map<string, string>> {
	const pathsByArxivId = new Map<string, string[]>();
	for (const path of plazaPaths) {
		const arxivId = plazaMentionArxivId(path);
		if (!arxivId) continue;
		const list = pathsByArxivId.get(arxivId);
		if (list) list.push(path);
		else pathsByArxivId.set(arxivId, [path]);
	}
	if (pathsByArxivId.size === 0) return new Map();

	try {
		const entries = await withTimeout(
			callApi(
				() =>
					commands.plazaScratchPrepare({
						arxivIds: [...pathsByArxivId.keys()],
					}),
				{ fallback: "plaza.scratchFailed" },
			),
			PREPARE_TIMEOUT_MS,
		);
		const markdownByArxivId = new Map(
			entries
				.filter((entry) => entry.ok && entry.markdownPath)
				.map((entry) => [entry.arxivId, entry.markdownPath as string]),
		);
		const out = new Map<string, string>();
		for (const [arxivId, paths] of pathsByArxivId) {
			const markdownPath = markdownByArxivId.get(arxivId);
			if (!markdownPath) continue;
			for (const path of paths) out.set(path, markdownPath);
		}
		return out;
	} catch {
		// Timeout / IPC failure: the turn still sends with abstracts only.
		// The host-side download (if any) keeps running and caches for retry.
		return new Map();
	}
}

/** Scratch cache usage for the Settings row. Throws on IPC failure. */
export async function plazaScratchStats(): Promise<PlazaScratchStats> {
	return callApi(() => commands.plazaScratchStats(), {
		fallback: "plaza.scratchFailed",
	});
}

/** Delete every scratch paper; returns the freed byte count. Throws on failure. */
export async function plazaScratchClear(): Promise<PlazaScratchClearResult> {
	return callApi(() => commands.plazaScratchClear(), {
		fallback: "plaza.scratchFailed",
	});
}
