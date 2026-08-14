import type { SelectionContext } from "@/lib/agent/selection-store";
import { isMarkdownPath, joinVaultPath, readVaultFile } from "@/lib/vault";

export type VoiceDefenseContext = {
	text: string;
	source: string;
};

export function combineVoiceDefenseContext(
	selectionText: string,
	documentText: string,
): string {
	return [
		selectionText ? `Selected excerpts:\n${selectionText}` : "",
		documentText ? `Current notes:\n${documentText}` : "",
	]
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

async function readCurrentDocument(
	vaultPath: string,
	currentFilePath: string | null,
): Promise<{ text: string; source: string }> {
	if (!currentFilePath) return { text: "", source: "" };
	const relative = isMarkdownPath(currentFilePath)
		? currentFilePath
		: `${currentFilePath.replace(/\/+$/, "")}/NOTES.md`;
	try {
		return {
			text: (await readVaultFile(joinVaultPath(vaultPath, relative))).trim(),
			source: relative,
		};
	} catch {
		return { text: "", source: currentFilePath };
	}
}

export async function collectVoiceDefenseContext(input: {
	vaultPath: string;
	currentFilePath: string | null;
	selections: SelectionContext[];
}): Promise<VoiceDefenseContext> {
	const selectionText = input.selections
		.map((selection) => {
			const page = selection.page ? `, p.${selection.page}` : "";
			return `[${selection.sourcePath}${page}]\n${selection.text.trim()}`;
		})
		.filter(Boolean)
		.join("\n\n");
	const document = await readCurrentDocument(
		input.vaultPath,
		input.currentFilePath,
	);
	return {
		text: combineVoiceDefenseContext(selectionText, document.text),
		source: document.source || input.currentFilePath || "",
	};
}
