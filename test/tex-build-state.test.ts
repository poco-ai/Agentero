import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueTexBuild } from "@/lib/tex/build-queue";
import {
	beginTexBuild,
	finishTexBuild,
	receiveTexLog,
	receiveTexResult,
	setTexDependencies,
	texBuildStore,
} from "@/lib/tex/build-state";
import type { LatexCompileResult } from "@/lib/tex/host";

const ROOT = "/vault/main.tex";
const result = (jobId: string): LatexCompileResult => ({
	jobId,
	rootPath: ROOT,
	success: true,
	pdfPath: "/vault/main.pdf",
	logPath: "/vault/main.log",
	synctexPath: "/vault/main.synctex.gz",
	dependencies: [ROOT],
	diagnostics: [],
});
beforeEach(() => texBuildStore.setState({ byRoot: {}, dependencies: {} }));

it("retains structural bibliography dependencies missing from TeX recorder output", () => {
	setTexDependencies(ROOT, [ROOT, "/vault/refs.bib"]);
	receiveTexResult(result("first"));
	expect(texBuildStore.getState().dependencies[ROOT]).toContain(
		"/vault/refs.bib",
	);
});

it("observes later builds started by another window", () => {
	receiveTexLog({ rootPath: ROOT, jobId: "first", line: "first log" });
	receiveTexResult(result("first"));
	receiveTexLog({ rootPath: ROOT, jobId: "second", line: "second log" });
	receiveTexResult(result("second"));
	expect(texBuildStore.getState().byRoot[ROOT]).toMatchObject({
		jobId: "second",
		logs: ["second log"],
		status: "succeeded",
	});
});

it("keeps unrelated jobs from overwriting an active build", () => {
	beginTexBuild(ROOT);
	receiveTexLog({ rootPath: ROOT, jobId: "current", line: "current log" });
	receiveTexResult(result("stale"));
	expect(texBuildStore.getState().byRoot[ROOT]).toMatchObject({
		jobId: "current",
		status: "running",
	});
});

it("does not let a resolved job hide a compile that already failed", () => {
	beginTexBuild(ROOT);
	receiveTexLog({ rootPath: ROOT, jobId: "job", line: "error line" });
	receiveTexResult({
		...result("job"),
		success: false,
		diagnostics: [
			{
				path: ROOT,
				line: 3,
				column: 1,
				severity: "error",
				message: "undefined control sequence",
				source: "build",
			},
		],
	});
	finishTexBuild(ROOT, "succeeded");
	expect(texBuildStore.getState().byRoot[ROOT]).toMatchObject({
		status: "failed",
		logs: ["error line"],
		diagnostics: [
			{
				path: ROOT,
				line: 3,
				column: 1,
				severity: "error",
				message: "undefined control sequence",
				source: "build",
			},
		],
	});
});

it("surfaces preflight failures in the same editor problem list", () => {
	beginTexBuild(ROOT);
	finishTexBuild(ROOT, "failed", "latexmk not found");
	expect(texBuildStore.getState().byRoot[ROOT].diagnostics).toEqual([
		{
			path: ROOT,
			line: 1,
			column: 1,
			severity: "error",
			message: "latexmk not found",
			source: "build",
		},
	]);
});

describe("queueTexBuild", () => {
	it("serializes projects and coalesces their trailing requests", async () => {
		let finish!: () => void;
		const sequence: string[] = [];
		const first = queueTexBuild(
			"a",
			() =>
				new Promise<void>((resolve) => {
					sequence.push("first");
					finish = resolve;
				}),
		);
		const old = queueTexBuild("a", async () => {
			sequence.push("obsolete");
		});
		const other = queueTexBuild("b", async () => {
			sequence.push("other");
		});
		const latest = queueTexBuild("a", async () => {
			sequence.push("latest");
		});
		finish();
		await Promise.all([first, old, other, latest]);
		expect(sequence).toEqual(["first", "latest", "other"]);
	});

	it("keeps a queued explicit rebuild when an automatic request arrives", async () => {
		let finish!: () => void;
		const first = queueTexBuild(
			"a",
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const rebuild = vi.fn(async () => undefined);
		const automatic = vi.fn(async () => undefined);
		const manual = queueTexBuild("a", rebuild, 2);
		const auto = queueTexBuild("a", automatic);
		finish();
		await Promise.all([first, manual, auto]);
		expect(rebuild).toHaveBeenCalledOnce();
		expect(automatic).not.toHaveBeenCalled();
	});

	it("releases the queue after a failed operation", async () => {
		const failed = queueTexBuild("bad", async () => {
			throw new Error("failed");
		});
		const next = vi.fn(async () => undefined);
		const done = queueTexBuild("next", next);
		await expect(failed).rejects.toThrow("failed");
		await done;
		expect(next).toHaveBeenCalledOnce();
	});
});
