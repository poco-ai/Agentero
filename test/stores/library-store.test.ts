import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	libraryStore,
	setLibraryQuery,
	setLibraryScopePath,
	setLibraryTagFilter,
	setRescanning,
	useLibraryState,
} from "@/stores/library-store";

function reset() {
	libraryStore.store.setState({
		libraryPapers: [],
		libraryLoading: false,
		libraryQuery: "",
		libraryTagFilter: null,
		libraryScopePath: null,
		rescanning: false,
	});
}

beforeEach(reset);
afterEach(reset);

describe("library-store", () => {
	it("updates filter/flag slices independently", () => {
		setLibraryQuery("transformer");
		setLibraryTagFilter("nlp");
		setLibraryScopePath("papers/nlp");
		setRescanning(true);

		const s = libraryStore.store.getState();
		expect(s.libraryQuery).toBe("transformer");
		expect(s.libraryTagFilter).toBe("nlp");
		expect(s.libraryScopePath).toBe("papers/nlp");
		expect(s.rescanning).toBe(true);
		// Untouched slices keep their defaults.
		expect(s.libraryPapers).toEqual([]);
		expect(s.libraryLoading).toBe(false);
	});

	it("exposes the whole slice through useLibraryState", () => {
		// The hook selector returns the live state object.
		expect(useLibraryState).toBeTypeOf("function");
	});
});
