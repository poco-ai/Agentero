export type AcpCommandPrefix = "/" | "$";

export type AcpCommand = {
	id: string;
	/** Name without the advertised prefix. */
	name: string;
	/** Prefix the agent advertised; Composer must send this exact form. */
	prefix: AcpCommandPrefix;
	title: string;
	description: string;
	inputHint?: string;
};

/**
 * Normalize an ACP available-command name for identity and matching.
 * Agents may advertise names with leading `/` and/or `$` (e.g. skills as `$name`).
 * The advertised prefix is preserved separately on {@link AcpCommand}.
 */
export function normalizeAcpCommandName(raw: string): string {
	return raw.trim().replace(/^[/$]+/, "");
}

/** Canonical invocation for a command: the prefix the agent advertised. */
export function acpCommandInvocation(
	command: Pick<AcpCommand, "name" | "prefix">,
): string {
	return `${command.prefix}${command.name}`;
}

export function mapAcpCommands(
	commands: Array<{
		name: string;
		description: string;
		input?: { hint: string } | null;
	}>,
): AcpCommand[] {
	const mapped: AcpCommand[] = [];
	const seen = new Set<string>();
	for (const command of commands) {
		const raw = command.name.trim();
		const name = normalizeAcpCommandName(raw);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		mapped.push({
			id: `acp:${name}`,
			name,
			prefix: raw.startsWith("$") ? "$" : "/",
			title: name,
			description: command.description.trim(),
			inputHint: command.input?.hint?.trim() || undefined,
		});
	}
	return mapped;
}

export type AcpCommandMatch = {
	command: AcpCommand;
	/** Canonical invocation with the original trailing arguments. */
	text: string;
};

/**
 * Match a sent line against the agent's commands. Both advertised prefixes
 * resolve to the same command, so `/skill` and `$skill` both produce the
 * canonical `$skill` text the agent accepts.
 */
export function matchAcpCommandText(
	commands: AcpCommand[],
	text: string,
): AcpCommandMatch | null {
	const match = /^([/$])(\S+)([\s\S]*)$/.exec(text.trimStart());
	if (!match) return null;
	const name = normalizeAcpCommandName(match[2] ?? "");
	const command = commands.find((candidate) => candidate.name === name);
	if (!command) return null;
	return {
		command,
		text: `${acpCommandInvocation(command)}${match[3] ?? ""}`,
	};
}

export function filterSlashCommands(
	commands: AcpCommand[],
	query: string,
): AcpCommand[] {
	const q = normalizeAcpCommandName(query).toLowerCase().trim();
	return commands
		.filter((command) => {
			if (!q) return true;
			return [command.name, command.title, command.description].some((value) =>
				value.toLowerCase().includes(q),
			);
		})
		.slice(0, 8);
}
