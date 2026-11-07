import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

export type ResearchTableSummary = {
	path: string;
	id: string;
	name: string;
	idPrefix?: string;
};

export type ResearchTableListResult = {
	tables: ResearchTableSummary[];
	truncated: boolean;
};

export type ResearchTableBacklink = {
	path: string;
};

const EMPTY_LIST: ResearchTableListResult = { tables: [], truncated: false };

/** Existing `*.table.json` files in the vault, capped by the host walk. */
export async function listResearchTables(
	vaultPath: string,
): Promise<ResearchTableListResult> {
	if (!isTauri() || !vaultPath) return EMPTY_LIST;
	const wire = await callApi(() => commands.researchTableList({ vaultPath }), {
		fallback: "research_table_list failed",
	});
	return {
		truncated: wire.truncated,
		tables: wire.tables.map((table) => ({
			path: table.path,
			id: table.id,
			name: table.name,
			idPrefix: table.idPrefix ?? undefined,
		})),
	};
}

/** Notes whose research-table directive names this path or id. */
export async function researchTableBacklinks(opts: {
	vaultPath: string;
	path: string;
	id?: string;
}): Promise<ResearchTableBacklink[]> {
	if (!isTauri() || !opts.vaultPath || !opts.path) return [];
	const wire = await callApi(
		() =>
			commands.researchTableBacklinks({
				vaultPath: opts.vaultPath,
				path: opts.path,
				id: opts.id ?? null,
			}),
		{ fallback: "research_table_backlinks failed" },
	);
	return wire.notes.map((note) => ({ path: note.path }));
}
