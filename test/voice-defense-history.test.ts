import { beforeEach, describe, expect, it, vi } from "vitest";
import { listVoiceDefenseHistory } from "@/lib/voice-defense/review/history";
import {
	buildVoiceTranscriptMarkdown,
	parseVoiceTranscriptMeta,
	VOICE_TRANSCRIPT_KIND,
	withTranscriptReviewLink,
} from "@/lib/voice-defense/transcript";

vi.mock("@/lib/vault", () => ({
	joinVaultPath: (root: string, rel: string) =>
		`${root.replace(/\/$/, "")}/${rel}`,
	listVaultDirChildren: vi.fn(),
	readVaultFile: vi.fn(),
}));

import { listVaultDirChildren, readVaultFile } from "@/lib/vault";

const listChildren = vi.mocked(listVaultDirChildren);
const readFile = vi.mocked(readVaultFile);

function transcript(materials: string[], started = "2026-08-08T09:07:06") {
	return buildVoiceTranscriptMarkdown({
		title: "A paper",
		source: "voice-defense/preparations/run-1/defense-brief.md",
		context: "The experiment uses three seeds.",
		startedAt: new Date(2026, 7, 8, 9, 7, 6),
		captions: [{ id: "m1", role: "assistant", text: "Why three seeds?" }],
		language: "zh-CN",
		durationSeconds: 720,
		materials,
		preparationRun: "run-1",
		scenario: "defense",
		debrief: {
			askedCount: 1,
			totalCount: 3,
			questions: [],
		},
	}).replace(/started: .*/, `started: ${started}`);
}

describe("voice defense history", () => {
	beforeEach(() => {
		listChildren.mockReset();
		readFile.mockReset();
	});

	it("round-trips transcript frontmatter and can attach a review link", () => {
		const markdown = transcript(["papers/demo"]);
		const meta = parseVoiceTranscriptMeta(markdown);
		expect(meta).toMatchObject({
			kind: VOICE_TRANSCRIPT_KIND,
			materials: ["papers/demo"],
			preparationRun: "run-1",
			scenario: "defense",
			language: "zh-CN",
			coverage: "1/3",
			durationSeconds: 720,
		});
		const linked = withTranscriptReviewLink(
			markdown,
			"voice-defense/20260808-090706-review.md",
			["variance reporting"],
		);
		expect(parseVoiceTranscriptMeta(linked)).toMatchObject({
			review: "voice-defense/20260808-090706-review.md",
			weakAreas: ["variance reporting"],
		});
		expect(parseVoiceTranscriptMeta("# legacy transcript\n")).toBeNull();
	});

	it("lists matching transcripts and skips reviews, preparations, and legacy files", async () => {
		listChildren.mockResolvedValue([
			{
				id: "match",
				name: "20260808-090706.md",
				path: "/vault/voice-defense/20260808-090706.md",
				kind: "file",
			},
			{
				id: "other",
				name: "20260807-120000.md",
				path: "/vault/voice-defense/20260807-120000.md",
				kind: "file",
			},
			{
				id: "review",
				name: "20260808-090706-review.md",
				path: "/vault/voice-defense/20260808-090706-review.md",
				kind: "file",
			},
			{
				id: "legacy",
				name: "20260801-010101.md",
				path: "/vault/voice-defense/20260801-010101.md",
				kind: "file",
			},
		]);
		readFile.mockImplementation(async (path) => {
			if (path.endsWith("20260808-090706.md")) {
				return transcript(["papers/demo", "slides/talk.md"]);
			}
			if (path.endsWith("20260807-120000.md")) {
				return transcript(["papers/other"]);
			}
			return "# no frontmatter\n";
		});

		const entries = await listVoiceDefenseHistory("/vault", [
			"slides/talk.md",
			"papers/demo",
		]);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.transcriptPath).toBe("voice-defense/20260808-090706.md");
		expect(listChildren).toHaveBeenCalledWith("/vault", "/vault/voice-defense");
		expect(await listVoiceDefenseHistory("/vault", ["papers/demo"])).toEqual(
			[],
		);
	});
});
