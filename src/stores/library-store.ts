/**
 * Papers Library view state: the loaded catalog rows, load/rescan flags, and
 * the title-search / tag / folder-scope filters. Backed by a Zustand store with
 * useState-compatible setters so existing call sites move over unchanged.
 */

import type { PaperMetadata } from "@/lib/paper-metadata";
import { createAppStore } from "@/stores/create";

export type LibraryState = {
	/** Catalog rows for the library table (loaded once per vault into memory). */
	libraryPapers: PaperMetadata[];
	libraryLoading: boolean;
	/** Title search query for the papers library view. */
	libraryQuery: string;
	/** Tag filter for the papers library view (exact match). */
	libraryTagFilter: string | null;
	/**
	 * Vault-relative folder filter for the single Library tab
	 * (e.g. `papers/nlp/pretrain`). Null = full library.
	 */
	libraryScopePath: string | null;
	/** Catalog rescan (recover disk-only papers) in progress. */
	rescanning: boolean;
};

export const libraryStore = createAppStore<LibraryState>(() => ({
	libraryPapers: [],
	libraryLoading: false,
	libraryQuery: "",
	libraryTagFilter: null,
	libraryScopePath: null,
	rescanning: false,
}));

type Updater<T> = T | ((prev: T) => T);

function apply<K extends keyof LibraryState>(
	key: K,
	next: Updater<LibraryState[K]>,
): void {
	libraryStore.store.setState((s) => {
		const value =
			typeof next === "function"
				? (next as (prev: LibraryState[K]) => LibraryState[K])(s[key])
				: next;
		return { [key]: value } as Pick<LibraryState, K>;
	});
}

export function setLibraryPapers(next: Updater<PaperMetadata[]>): void {
	apply("libraryPapers", next);
}

export function setLibraryLoading(next: Updater<boolean>): void {
	apply("libraryLoading", next);
}

export function setLibraryQuery(next: Updater<string>): void {
	apply("libraryQuery", next);
}

export function setLibraryTagFilter(next: Updater<string | null>): void {
	apply("libraryTagFilter", next);
}

export function setLibraryScopePath(next: Updater<string | null>): void {
	apply("libraryScopePath", next);
}

export function setRescanning(next: Updater<boolean>): void {
	apply("rescanning", next);
}

/** Subscribe a component to the whole library slice. */
export function useLibraryState(): LibraryState {
	return libraryStore.use((s) => s);
}
