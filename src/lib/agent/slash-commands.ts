export type AcpCommandPrefix = "/" | "$";

export type AcpCommand = {
	id: string;
	/** Name without the advertised prefix. */
	name: string;
	/** Prefix the agent advertised; Composer must send this exact form. */
	prefix: AcpCommandPrefix;
	/**
	 * Slash-menu source. ACP commands are sent as text; local skills attach the
	 * skill token so the Host can inject the SKILL.md body and skillIds.
	 */
	kind?: "command" | "skill";
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
			kind: "command",
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

export type LocalSkillCandidate = {
	id: string;
	name: string;
	description: string;
};

/**
 * Local SKILL.md entries offered by the `/` menu as well as `$`. They are
 * synthetic slash options: selecting one must attach the skill token, not send
 * a literal command. ACP commands with the same name win to avoid duplicates.
 */
export function mapSkillSlashCommands(
	skills: LocalSkillCandidate[],
	query: string,
	options: {
		excludeIds?: ReadonlySet<string>;
		excludeNames?: ReadonlySet<string>;
		limit?: number;
	} = {},
): AcpCommand[] {
	const q = normalizeAcpCommandName(query).toLowerCase().trim();
	const excludeIds = options.excludeIds ?? new Set<string>();
	const excludeNames = options.excludeNames ?? new Set<string>();
	return skills
		.filter((skill) => !excludeIds.has(skill.id))
		.filter(
			(skill) =>
				!excludeNames.has(skill.id.toLowerCase()) &&
				!excludeNames.has(skill.name.toLowerCase()),
		)
		.filter((skill) => {
			if (!q) return true;
			return `${skill.id} ${skill.name} ${skill.description}`
				.toLowerCase()
				.includes(q);
		})
		.slice(0, options.limit ?? 6)
		.map((skill) => ({
			id: `skill:${skill.id}`,
			name: skill.id,
			prefix: "/",
			kind: "skill",
			title: skill.name,
			description: skill.description,
		}));
}

/** `/` candidates: ACP commands first, then matching local skills. */
export function buildSlashOptions(
	commands: AcpCommand[],
	skills: LocalSkillCandidate[],
	query: string,
	options: {
		selectedSkillIds?: ReadonlySet<string>;
		limit?: number;
	} = {},
): AcpCommand[] {
	const acpCommands = filterSlashCommands(commands, query);
	const commandNames = new Set(
		acpCommands.map((command) => command.name.toLowerCase()),
	);
	return [
		...acpCommands,
		...mapSkillSlashCommands(skills, query, {
			excludeIds: options.selectedSkillIds,
			excludeNames: commandNames,
		}),
	].slice(0, options.limit ?? 10);
}
