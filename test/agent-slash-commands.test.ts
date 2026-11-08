import { describe, expect, it } from "vitest";
import {
	type AcpCommand,
	acpCommandInvocation,
	filterSlashCommands,
	mapAcpCommands,
	matchAcpCommandText,
	normalizeAcpCommandName,
} from "@/lib/agent/slash-commands";

describe("agent-slash-commands", () => {
	it("maps ACP commands and strips leading slashes", () => {
		const commands = mapAcpCommands([
			{
				name: "/search",
				description: "Search the web",
				input: { hint: "query" },
			},
			{ name: "  /read  ", description: "Read papers", input: null },
		]);
		expect(commands).toEqual<AcpCommand[]>([
			{
				id: "acp:search",
				name: "search",
				prefix: "/",
				title: "search",
				description: "Search the web",
				inputHint: "query",
			},
			{
				id: "acp:read",
				name: "read",
				prefix: "/",
				title: "read",
				description: "Read papers",
				inputHint: undefined,
			},
		]);
	});

	it("keeps the advertised $ prefix for ACP skills", () => {
		const commands = mapAcpCommands([
			{
				name: "$deep-research",
				description: "Runs a deep research",
				input: null,
			},
			{
				name: "/$idea-evaluator",
				description: "Evaluates an idea",
				input: null,
			},
			{ name: "  $$git-master  ", description: "Git expert", input: null },
		]);
		expect(commands.map((c) => c.name)).toEqual([
			"deep-research",
			"idea-evaluator",
			"git-master",
		]);
		expect(commands.map((c) => c.title)).toEqual([
			"deep-research",
			"idea-evaluator",
			"git-master",
		]);
		expect(commands.map((c) => c.prefix)).toEqual(["$", "/", "$"]);
		expect(commands.map(acpCommandInvocation)).toEqual([
			"$deep-research",
			"/idea-evaluator",
			"$git-master",
		]);
	});

	it("resolves / and $ to the same advertised invocation", () => {
		const commands = mapAcpCommands([
			{ name: "$deep-research", description: "Research", input: null },
			{ name: "/summary", description: "Summarize", input: null },
		]);
		expect(matchAcpCommandText(commands, "$deep-research")?.text).toBe(
			"$deep-research",
		);
		expect(matchAcpCommandText(commands, "/deep-research")?.text).toBe(
			"$deep-research",
		);
		expect(
			matchAcpCommandText(commands, "/deep-research with args")?.text,
		).toBe("$deep-research with args");
		expect(matchAcpCommandText(commands, "/summary")?.text).toBe("/summary");
		expect(matchAcpCommandText(commands, "/$summary")?.text).toBe("/summary");
		expect(matchAcpCommandText(commands, "$missing")).toBeNull();
		expect(matchAcpCommandText(commands, "plain text")).toBeNull();
	});

	it("matches filter queries with either advertised prefix", () => {
		const commands = mapAcpCommands([
			{ name: "$deep-research", description: "Research", input: null },
			{ name: "/summary", description: "Summarize", input: null },
		]);
		expect(filterSlashCommands(commands, "$deep").map((c) => c.name)).toEqual([
			"deep-research",
		]);
		expect(filterSlashCommands(commands, "/deep").map((c) => c.name)).toEqual([
			"deep-research",
		]);
	});

	it("normalizeAcpCommandName strips mixed / and $ prefixes", () => {
		expect(normalizeAcpCommandName("$foo")).toBe("foo");
		expect(normalizeAcpCommandName("/$foo")).toBe("foo");
		expect(normalizeAcpCommandName("/foo")).toBe("foo");
		expect(normalizeAcpCommandName("  /$bar  ")).toBe("bar");
		expect(normalizeAcpCommandName("plain")).toBe("plain");
	});

	it("filters out empty ACP command names", () => {
		const commands = mapAcpCommands([
			{ name: "", description: "Empty", input: null },
			{ name: "/valid", description: "Valid", input: null },
			{ name: "$", description: "Only dollar", input: null },
			{ name: "/$", description: "Only markers", input: null },
		]);
		expect(commands).toHaveLength(1);
		expect(commands[0].name).toBe("valid");
	});

	it("filters commands by query across name, title and description", () => {
		const commands = mapAcpCommands([
			{ name: "summary", description: "Summarize the paper", input: null },
			{ name: "qa", description: "Ask a question", input: null },
		]);
		const result = filterSlashCommands(commands, "sum");
		expect(result.map((c) => c.name)).toContain("summary");
		expect(result.map((c) => c.name)).not.toContain("qa");
	});

	it("returns all commands when query is empty", () => {
		const commands = mapAcpCommands([
			{ name: "one", description: "First", input: null },
			{ name: "two", description: "Second", input: null },
		]);
		const result = filterSlashCommands(commands, "");
		expect(result).toHaveLength(2);
	});

	it("is case-insensitive", () => {
		const commands = mapAcpCommands([
			{ name: "Summary", description: "SUMMARY", input: null },
		]);
		const result = filterSlashCommands(commands, "SUM");
		expect(result).toHaveLength(1);
	});

	it("limits results to 8", () => {
		const commands = mapAcpCommands(
			Array.from({ length: 12 }, (_, i) => ({
				name: `cmd-${i}`,
				description: `Command ${i}`,
				input: null,
			})),
		);
		const result = filterSlashCommands(commands, "");
		expect(result).toHaveLength(8);
	});
});
