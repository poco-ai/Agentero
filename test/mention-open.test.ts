import { beforeEach, describe, expect, it, vi } from "vitest";

const { openFolderLibrary, openPlazaMentionPath, openVaultRel } = vi.hoisted(
	() => ({
		openFolderLibrary: vi.fn(),
		openPlazaMentionPath: vi.fn(),
		openVaultRel: vi.fn(),
	}),
);
vi.mock("@/lib/plaza/mention-open", () => ({ openPlazaMentionPath }));
vi.mock("@/lib/workspace/actions", () => ({
	openFolderLibrary,
	openVaultRel,
}));

import { openMentionTarget } from "@/lib/agent/mention-open";

beforeEach(() => {
	openFolderLibrary.mockClear();
	openPlazaMentionPath.mockClear();
	openVaultRel.mockClear();
});

describe("openMentionTarget", () => {
	it("opens plaza references in the Plaza tab", () => {
		openMentionTarget("agentero:plaza/feeds/feed-1");
		openMentionTarget("agentero:plaza/arxiv-rec/2409.12345");

		expect(openPlazaMentionPath).toHaveBeenCalledTimes(2);
		expect(openVaultRel).not.toHaveBeenCalled();
	});

	it("opens vault paths in the workspace", () => {
		openMentionTarget("papers/attention/NOTES.md");

		expect(openVaultRel).toHaveBeenCalledWith("papers/attention/NOTES.md");
		expect(openPlazaMentionPath).not.toHaveBeenCalled();
	});

	it("scopes the library for a plain folder mention", () => {
		openMentionTarget("notes");

		expect(openFolderLibrary).toHaveBeenCalledWith("notes");
		expect(openVaultRel).not.toHaveBeenCalled();
	});

	it("ignores empty paths", () => {
		openMentionTarget("   ");
		openMentionTarget(null);

		expect(openVaultRel).not.toHaveBeenCalled();
		expect(openFolderLibrary).not.toHaveBeenCalled();
		expect(openPlazaMentionPath).not.toHaveBeenCalled();
	});
});
