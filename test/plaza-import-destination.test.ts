import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import { enqueueTaskSettled, type TaskExecutorContext } from "@/lib/core/tasks";
import { lookupSubmit } from "@/lib/paper/import-actions";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import { importPlazaPaper, runPlazaImportJob } from "@/lib/plaza/import";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => {
	const imported = async () => ({
		status: "ok",
		data: { ok: true, data: { status: "created", title: "Paper", pdf: true } },
	});
	return {
		commands: {
			paperCoolpapersImport: vi.fn(imported),
			paperPwcImport: vi.fn(imported),
		},
	};
});
vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifySuccess: vi.fn(),
	notifyWarning: vi.fn(),
}));
vi.mock("@/lib/core/tasks", () => ({
	enqueueTaskSettled: vi.fn(async () => {}),
}));
vi.mock("@/lib/paper/import-actions", () => ({
	lookupSubmit: vi.fn(async () => {}),
}));
vi.mock("@/lib/paper/library-actions", () => ({
	currentLookupParentDir: vi.fn(() => "papers/default"),
}));
vi.mock("@/lib/paper/library-store", () => ({
	refreshLibrary: vi.fn(async () => {}),
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => "/vault",
	refreshTree: vi.fn(async () => {}),
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentLookupParentDir).mockReturnValue("papers/default");
	vi.mocked(lookupSubmit).mockImplementation(async (_urls, options) => {
		await options?.onComplete?.({ imported: ["paper"], errors: [] });
	});
});

describe("Plaza import destination", () => {
	it("passes the selected folder through the arXiv lookup route", async () => {
		await expect(
			importPlazaPaper(
				{
					id: "2501.00001",
					url: "https://arxiv.org/abs/2501.00001",
					title: null,
				},
				"papers/中文/NLP",
			),
		).resolves.toBe(true);
		expect(lookupSubmit).toHaveBeenCalledWith(
			["https://arxiv.org/abs/2501.00001"],
			expect.objectContaining({ parentDir: "papers/中文/NLP" }),
		);
	});

	it("keeps the tree-selection default for callers without an explicit destination", async () => {
		await importPlazaPaper({
			id: "2501.00001",
			url: "https://arxiv.org/abs/2501.00001",
			title: null,
		});
		expect(lookupSubmit).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ parentDir: "papers/default" }),
		);
	});

	it.each([
		{
			url: "https://papers.cool/venue/123@AAAI",
			command: "paperCoolpapersImport" as const,
		},
		{
			url: "https://paperswithcode.co/paper/2501.00001",
			command: "paperPwcImport" as const,
		},
	])("keeps the queued destination for $command after the sidebar selection changes", async ({
		url,
		command,
	}) => {
		await expect(
			importPlazaPaper(
				{ id: "2501.00001", url, title: null },
				"papers/中文/NLP",
			),
		).resolves.toBe(true);
		const [job] = vi.mocked(enqueueTaskSettled).mock.calls[0];
		expect(job.path).toBe("papers/中文/NLP");
		vi.mocked(currentLookupParentDir).mockReturnValue("papers/changed");
		await runPlazaImportJob({
			jobId: "job-1",
			kind: "import",
			vaultPath: job.vaultPath,
			paperPath: job.path,
			params: job.params,
			force: false,
			signal: new AbortController().signal,
			report: vi.fn(),
		} as TaskExecutorContext);
		expect(commands[command]).toHaveBeenCalledWith(
			expect.objectContaining({
				vaultPath: "/vault",
				parentDir: "papers/中文/NLP",
				taskId: "job-1",
			}),
		);
	});
});
