import type { ToolUiState } from "./chat-state";

export type TerminalToolData = {
	command: string;
	cwd?: string;
	output: string;
	exitCode?: number;
	metadata?: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Narrow ACP execute payloads without guessing from tool names or log text. */
export function terminalToolData(tool: ToolUiState): TerminalToolData | null {
	if (tool.kind !== "execute" || !record(tool.input)) return null;
	const { command, cwd } = tool.input;
	// Retain the generic renderer when narrowing would hide other parameters.
	if (
		typeof command !== "string" ||
		!command.trim() ||
		(cwd !== undefined && typeof cwd !== "string") ||
		Object.keys(tool.input).some((key) => !["command", "cwd"].includes(key))
	)
		return null;
	const input = { command, ...(typeof cwd === "string" ? { cwd } : {}) };
	if (tool.output === undefined) return { ...input, output: "" };
	if (typeof tool.output === "string") return { ...input, output: tool.output };
	if (!record(tool.output)) return null;
	const { stdout, stderr, metadata } = tool.output;
	if (metadata !== undefined && !record(metadata)) return null;
	const exitCode =
		tool.output.exitCode ?? (record(metadata) ? metadata.exit : undefined);
	if (
		Object.keys(tool.output).some(
			(key) => !["stdout", "stderr", "exitCode", "metadata"].includes(key),
		)
	)
		return null;
	if (
		typeof stdout !== "string" ||
		(stderr !== undefined && typeof stderr !== "string") ||
		(exitCode !== undefined &&
			(typeof exitCode !== "number" || !Number.isInteger(exitCode)))
	)
		return null;
	return {
		...input,
		output: [stdout, stderr]
			.filter((text) => text !== undefined && text !== "")
			.join("\n"),
		...(typeof exitCode === "number" ? { exitCode } : {}),
		...(record(metadata) ? { metadata } : {}),
	};
}
