import { beforeEach, expect, it, vi } from "vitest";
import type { LookupBatchAddResult } from "@/lib/paper/lookup";

/**
 * AlphaXiv's first identifier pass and the public-PDF fallback must share
 * the folder captured when import started. A paper already in the library
 * stays put: no second import, and no move.
 */
const mocks = vi.hoisted(() => ({
	enqueueLookup: vi.fn(),
	enqueueLookupBatch: vi.fn(),
}));

vi.mock("@/lib/paper/import-actions", () => ({
	enqueueLookup: mocks.enqueueLookup,
	enqueueLookupBatch: mocks.enqueueLookupBatch,
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => "/vault",
}));

import { importAlphaXivPlan } from "@/lib/paper/alphaxiv-import";

const item = {
	arxivId: "2401.00001",
	pdfUrl: "https://arxiv.org/pdf/2401.00001",
	title: "Pinned folder",
	folderNames: ["To read"],
};

function batchResult(
	patch: Partial<LookupBatchAddResult>,
): LookupBatchAddResult {
	return {
		imported: [],
		skills: [],
		skillCandidates: [],
		searchCandidates: [],
		skipped: [],
		errors: [],
		...patch,
	};
}

function queue(): { jobId: string; settled: Promise<void> } {
	return {
		jobId: "job",
		settled: Promise.resolve(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.enqueueLookupBatch.mockImplementation(
		async (
			_tokens: string[],
			opts?: { onComplete?: (result: LookupBatchAddResult) => void },
		) => {
			await opts?.onComplete?.(
				batchResult({
					errors: ["2401.00001: missing"],
				}),
			);
			return queue();
		},
	);
	mocks.enqueueLookup.mockImplementation(
		async (
			_tokens: string[],
			opts?: { onComplete?: (result: LookupBatchAddResult) => void },
		) => {
			await opts?.onComplete?.(
				batchResult({
					skipped: [
						{
							raw: "https://arxiv.org/pdf/2401.00001",
							kind: "url",
							value: "2401.00001",
							reason: "already_in_library",
						},
					],
				}),
			);
			return queue();
		},
	);
});

it("uses the same folder for the identifier batch and the PDF fallback", async () => {
	const summary = await importAlphaXivPlan([item], {
		tagFolders: false,
		parentDir: " papers/nlp ",
	});

	expect(summary.skippedExisting).toBe(1);
	expect(summary.imported).toBe(0);
	expect(mocks.enqueueLookupBatch).toHaveBeenCalledWith(
		["2401.00001"],
		expect.objectContaining({ parentDir: "papers/nlp" }),
	);
	expect(mocks.enqueueLookup).toHaveBeenCalledWith(
		["https://arxiv.org/pdf/2401.00001"],
		expect.objectContaining({ parentDir: "papers/nlp" }),
	);
});

it("omits the folder so both steps keep the current lookup destination", async () => {
	await importAlphaXivPlan([item], { tagFolders: false, parentDir: "  " });

	expect(mocks.enqueueLookupBatch).toHaveBeenCalledWith(
		["2401.00001"],
		expect.objectContaining({ parentDir: undefined }),
	);
	expect(mocks.enqueueLookup).toHaveBeenCalledWith(
		["https://arxiv.org/pdf/2401.00001"],
		expect.objectContaining({ parentDir: undefined }),
	);
});

it("does not import again when the paper is already in the library", async () => {
	mocks.enqueueLookupBatch.mockImplementation(
		async (
			_tokens: string[],
			opts?: { onComplete?: (result: LookupBatchAddResult) => void },
		) => {
			await opts?.onComplete?.(
				batchResult({
					skipped: [
						{
							raw: "2401.00001",
							kind: "arxiv",
							value: "2401.00001",
							reason: "already_in_library",
						},
					],
				}),
			);
			return queue();
		},
	);

	const summary = await importAlphaXivPlan([item], {
		tagFolders: false,
		parentDir: "papers/nlp",
	});

	expect(summary.skippedExisting).toBe(1);
	expect(mocks.enqueueLookup).not.toHaveBeenCalled();
});
