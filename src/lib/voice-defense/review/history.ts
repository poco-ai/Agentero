import {
	joinVaultPath,
	listVaultDirChildren,
	readVaultFile,
} from "@/lib/vault";
import {
	parseVoiceTranscriptMeta,
	VOICE_DEFENSE_DIRECTORY,
	type VoiceTranscriptMeta,
} from "@/lib/voice-defense/transcript";

export type VoiceDefenseHistoryEntry = VoiceTranscriptMeta & {
	transcriptPath: string;
};

function sameMaterials(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) return false;
	const a = [...left].sort();
	const b = [...right].sort();
	return a.every((path, index) => path === b[index]);
}

export async function listVoiceDefenseHistory(
	vaultRoot: string,
	materials: readonly string[] = [],
	limit = 8,
): Promise<VoiceDefenseHistoryEntry[]> {
	if (materials.length === 0) return [];
	let children: Array<{ name: string; kind: string; path: string }>;
	try {
		children = await listVaultDirChildren(
			vaultRoot,
			joinVaultPath(vaultRoot, VOICE_DEFENSE_DIRECTORY),
		);
	} catch {
		return [];
	}
	const files = children.filter(
		(child) =>
			child.kind === "file" &&
			child.name.toLowerCase().endsWith(".md") &&
			!child.name.toLowerCase().endsWith("-review.md"),
	);
	const entries: VoiceDefenseHistoryEntry[] = [];
	for (const file of files) {
		const relative = `${VOICE_DEFENSE_DIRECTORY}/${file.name}`;
		try {
			const markdown = await readVaultFile(file.path);
			const meta = parseVoiceTranscriptMeta(markdown);
			if (!meta) continue;
			if (!sameMaterials(meta.materials, materials)) continue;
			entries.push({ ...meta, transcriptPath: relative });
		} catch {
			// Skip unreadable or legacy files without frontmatter.
		}
	}
	entries.sort((a, b) => b.started.localeCompare(a.started));
	return entries.slice(0, limit);
}
