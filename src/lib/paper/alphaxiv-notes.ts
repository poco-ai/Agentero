import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation";
import { marked } from "marked";
import i18n from "@/i18n";
import { commands, type ImportedReadingRecord } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { notesPathForPaper } from "@/lib/paper/paths";
import { reviveAnnotationDates } from "@/lib/pdf/highlight/annotation-items";
import {
	mergeAnnotationItems,
	readAnnotationSnapshot,
} from "@/lib/pdf/highlight/annotation-store";
import { enqueueAnnotationSave } from "@/lib/pdf/highlight/annotation-sync";
import { joinVaultPath } from "@/lib/vault";
import { getVaultPath } from "@/lib/vault/store";
import { updateMarkdownOnDisk } from "@/lib/workspace/persistence";

export type AlphaXivNotesSummary = {
	added: number;
	existing: number;
	excerpts: number;
};

const SECTION = "AlphaXiv";

function appendAlphaXivNotes(current: string, blocks: string[]): string {
	if (!blocks.length) return current;
	const { frontmatter, body } = splitFrontmatter(current);
	const normalized = body.replace(/\r\n?/g, "\n");
	let offset = 0;
	let section = false;
	for (const token of marked.lexer(normalized)) {
		if (token.type === "heading" && token.depth <= 2) {
			if (section) break;
			section = token.depth === 2 && token.text === SECTION;
		}
		offset += token.raw.length;
	}
	const insertAt = section ? diskOffsetForMarkdown(body, offset) : body.length;
	const prefix = body.slice(0, insertAt);
	const suffix = body.slice(insertAt);
	const newline = current.includes("\r\n") ? "\r\n" : "\n";
	const gap =
		!prefix || /\n[ \t\r]*\n$/.test(prefix)
			? ""
			: prefix.endsWith("\n")
				? newline
				: newline.repeat(2);
	const added = `${section ? "" : `## ${SECTION}\n\n`}${blocks.join("\n\n")}\n${suffix ? "\n" : ""}`;
	const frontmatterGap =
		frontmatter && !frontmatter.endsWith("\n") ? newline : "";
	return `${frontmatter}${frontmatterGap}${prefix}${gap}${added.replace(/\r?\n/g, newline)}${suffix}`;
}

function diskOffsetForMarkdown(body: string, offset: number): number {
	let diskOffset = offset;
	for (const match of body.matchAll(/\r\n/g)) {
		if (match.index >= diskOffset) break;
		diskOffset += 1;
	}
	return diskOffset;
}

function annotationsFor(
	record: ImportedReadingRecord,
): AnnotationTransferItem[] {
	return record.annotations.map((item) =>
		reviveAnnotationDates(item as unknown as AnnotationTransferItem),
	);
}

export async function importAlphaXivNotes(input: {
	vaultPath: string;
	path: string;
	paperGroupId: string;
	arxivId: string;
}): Promise<AlphaXivNotesSummary> {
	const { vaultPath, path, paperGroupId, arxivId } = input;
	const records = await callApi(() =>
		commands.alphaxivPrepareNotes(vaultPath, path, paperGroupId, arxivId),
	);
	if (getVaultPath() !== vaultPath)
		throw new Error(i18n.t("sidebar:alphaxivImport.noVault"));
	const summary = { added: 0, existing: 0, excerpts: 0 };
	if (!records.length) return summary;
	const paperDir = joinVaultPath(vaultPath, path);
	await enqueueAnnotationSave(paperDir, async () => {
		const sourceIds = annotationSourceIds(
			(await readAnnotationSnapshot(paperDir)).items,
		);
		const incoming = new Map<string, AnnotationTransferItem[]>();
		const sourceUrl = `https://www.alphaxiv.org/abs/${arxivId}`;
		await updateMarkdownOnDisk(
			notesPathForPaper(paperDir),
			(current) => {
				const blockIds = new Set(
					Array.from(
						current.matchAll(/\^(alphaxiv-[\da-z-]+)[ \t]*\r?$/gim),
						(match) => match[1],
					),
				);
				const blocks: string[] = [];
				for (const record of records) {
					if (blockIds.has(record.sourceId) || sourceIds.has(record.sourceId)) {
						summary.existing += 1;
						continue;
					}
					if (record.markdown !== null) {
						blockIds.add(record.sourceId);
						blocks.push(
							`${record.markdown.trim()}\n\n[AlphaXiv](${sourceUrl}) ^${record.sourceId}`,
						);
						if (record.excerpt) summary.excerpts += 1;
						else summary.added += 1;
					} else {
						const items = annotationsFor(record);
						incoming.set(record.sourceId, items);
					}
				}
				return appendAlphaXivNotes(current, blocks);
			},
			i18n.t("sidebar:alphaxivImport.notesDirty"),
		);
		if (incoming.size) {
			const saved = await mergeAnnotationItems(
				paperDir,
				(disk) => {
					const current = annotationSourceIds(disk);
					const fresh = [...incoming].filter(([id]) => !current.has(id));
					const items = fresh.flatMap(([, items]) => items);
					return {
						items: items.length ? disk.concat(items) : disk,
						result: fresh.length,
					};
				},
				vaultPath,
			);
			summary.added += saved;
			summary.existing += incoming.size - saved;
		}
	});
	return summary;
}

function annotationSourceIds(items: AnnotationTransferItem[]): Set<string> {
	return new Set(
		items.flatMap(({ annotation }) =>
			annotation.id?.startsWith("alphaxiv-")
				? [annotation.id.replace(/-\d+$/, "")]
				: [],
		),
	);
}
