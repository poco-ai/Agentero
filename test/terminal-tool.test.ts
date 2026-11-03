import { describe, expect, it } from "vitest";
import type { ToolUiState } from "@/lib/agent/chat-state";
import { terminalToolData } from "@/lib/agent/terminal-tool";

const tool: ToolUiState = {
	id: "run",
	kind: "execute",
	title: "shell",
	status: "completed",
	input: { command: "pnpm test" },
	output: "passed",
};

describe("ACP terminal presentation", () => {
	it("renders native OpenCode command/cwd and ACP text with provider metadata", () => {
		const metadata = { status: "completed", truncated: false, exit: 0 };
		expect(
			terminalToolData({
				...tool,
				input: {
					command: "printf component_migration_probe",
					cwd: "/private/tmp/probe",
				},
				output: { stdout: "component_migration_probe", metadata },
			}),
		).toEqual({
			command: "printf component_migration_probe",
			cwd: "/private/tmp/probe",
			output: "component_migration_probe",
			exitCode: 0,
			metadata,
		});
	});
	it("uses structured command and plain output without interpreting log contents", () => {
		expect(terminalToolData({ ...tool, output: "exit code 7" })).toEqual({
			command: "pnpm test",
			output: "exit code 7",
		});
		expect(
			terminalToolData({
				...tool,
				output: { stdout: "out", stderr: "err", exitCode: 2 },
			}),
		).toEqual({ command: "pnpm test", output: "out\nerr", exitCode: 2 });
	});
	it("keeps unknown payloads and tools on the generic renderer", () => {
		for (const change of [
			{ kind: "read" },
			{ input: "pnpm test" },
			{ input: { command: "pnpm test", timeout: 30 } },
			{ output: { stdout: "out", metadata: "keep this" } },
			{ output: { stdout: "out", exitCode: "1" } },
			{ output: { stdout: "out", exitCode: Number.NaN } },
		]) {
			expect(terminalToolData({ ...tool, ...change })).toBeNull();
		}
	});
	it("accepts running commands before output arrives and preserves empty output", () => {
		expect(
			terminalToolData({ ...tool, status: "in_progress", output: undefined }),
		).toEqual({ command: "pnpm test", output: "" });
		expect(terminalToolData({ ...tool, output: "" })?.output).toBe("");
	});
});
