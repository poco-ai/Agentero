/**
 * Vault-wide full-text Markdown search via Host `vault_search`.
 * Powers the quick open's "In contents" tier (see quick-open.tsx).
 */

import { track } from "@/lib/activity";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { perfOp } from "@/lib/core/perf";
import { isTauri } from "@/lib/core/tauri";

export type SearchHit = {
	/** Vault-relative md file, e.g. papers/x/NOTES.md */
	path: string;
	/** Vault-relative paper folder when the hit is inside papers/… */
	paperPath?: string;
	title: string;
	snippet: string;
	/** 1-based line of the first match (0 when unknown). */
	line: number;
	score: number;
};

export type VaultSearchResult = {
	hits: SearchHit[];
	truncated: boolean;
};

const EMPTY: VaultSearchResult = { hits: [], truncated: false };

/** Full-text search over the Vault's Markdown files. Returns empty off-desktop. */
export async function searchVault(opts: {
	vaultPath: string;
	query: string;
	limit?: number;
}): Promise<VaultSearchResult> {
	if (!isTauri()) return EMPTY;
	const query = opts.query.trim();
	if (!query) return EMPTY;
	return perfOp("vault_search", async () => {
		const wire = await callApi(
			() =>
				commands.vaultSearch({
					vaultPath: opts.vaultPath,
					query,
					limit: opts.limit ?? null,
				}),
			{ fallback: "vault_search failed" },
		);
		const result: VaultSearchResult = {
			truncated: wire.truncated,
			hits: wire.hits.map((hit) => ({
				...hit,
				paperPath: hit.paperPath ?? undefined,
			})),
		};
		track("search.query", {
			extra: {
				q: query,
				hits: result.hits.length,
				truncated: result.truncated,
			},
		});
		return result;
	});
}
