import { normalizeArxivId } from "@/lib/paper/arxiv";
import { libraryStore, refreshLibrary } from "@/lib/paper/library-store";

/** Bare arXiv id, without a version suffix. ModelScope and the catalog disagree on `vN`. */
export function bareArxivId(raw: string): string | null {
	const id = normalizeArxivId(raw);
	if (!id) return null;
	return id.replace(/v\d+$/i, "").toLowerCase();
}

type ImportedPaper = {
	arxiv_id?: string | null;
	path?: string | null;
};

/** Ids from a ModelScope page that already match a library paper. */
export function matchingImportedIds(
	queried: string[],
	papers: ImportedPaper[],
): string[] {
	const have = new Set<string>();
	for (const paper of papers) {
		const folder = paper.path?.split(/[/\\]/).pop();
		for (const raw of [paper.arxiv_id, folder]) {
			if (!raw) continue;
			const bare = bareArxivId(raw);
			if (bare) have.add(bare);
		}
	}
	return queried.filter((id) => {
		const bare = bareArxivId(id);
		return bare != null && have.has(bare);
	});
}

function waitUntilLibraryIdle(): Promise<void> {
	if (!libraryStore.getState().loading) return Promise.resolve();
	return new Promise((resolve) => {
		const unsubscribe = libraryStore.subscribe((state) => {
			if (!state.loading) {
				unsubscribe();
				resolve();
			}
		});
	});
}

/** Answer a ModelScope frame that wants to label rows already in the library. */
export async function importedIdsInLibrary(ids: string[]): Promise<string[]> {
	const queried = ids
		.filter((id) => typeof id === "string" && id.trim())
		.slice(0, 200);
	if (!queried.length) return [];
	if (libraryStore.getState().papers.length === 0) {
		if (libraryStore.getState().loading) await waitUntilLibraryIdle();
		if (libraryStore.getState().papers.length === 0) await refreshLibrary();
	}
	return matchingImportedIds(queried, libraryStore.getState().papers);
}
