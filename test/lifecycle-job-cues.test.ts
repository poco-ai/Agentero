import { describe, expect, it } from "vitest";
import { jobTerminalCue } from "@/lib/lifecycle/job-cues";

describe("background job audio", () => {
	it("cues full-document layout translation only", () => {
		expect(jobTerminalCue("completed", "layoutTranslate")).toBe("done");
		expect(jobTerminalCue("failed", "layoutTranslate")).toBe("error");
	});

	it("keeps every other job kind silent", () => {
		for (const kind of [
			"import",
			"metadataRefresh",
			"latexCompile",
			"modelDownload",
			"layoutAnalyze",
			"wikiReindex",
			"parseBody",
		] as const) {
			expect(jobTerminalCue("completed", kind)).toBeNull();
			expect(jobTerminalCue("failed", kind)).toBeNull();
		}
	});
});
