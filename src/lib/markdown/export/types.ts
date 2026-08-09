import type { PaperMetadata } from "@/lib/paper/types";

/** Export format chosen in the dialog. */
export type MarkdownExportFormat = "pdf" | "png";

/** Options applied for a single export run. */
export type MarkdownExportOptions = {
	format: MarkdownExportFormat;
	/** Expand embed shells past editor max-height. Default true. */
	expandEmbeds: boolean;
	/**
	 * When the note is a paper `NOTES.md`, prepend title / authors / link.
	 * Ignored for non-paper notes. Default true when paper meta is available.
	 */
	includePaperHeader: boolean;
	/** Semi-transparent “Agentero” corner watermark. Default from settings. */
	watermark: boolean;
};

export type MarkdownExportPaperHeader = {
	title: string;
	authorsLine: string | null;
	year: number | null;
	link: string | null;
	linkLabel: string | null;
};

export type MarkdownExportRequest = {
	/** Full Markdown including optional frontmatter (body is rendered; FM stripped). */
	markdown: string;
	/** Absolute path of the source note (asset / wiki resolve). */
	filePath: string | null;
	/**
	 * Active Vault root for wiki embed resolution.
	 * Required because export mounts a separate React root without app providers.
	 */
	vaultPath: string | null;
	/** Vault wiki target files (annotation recovery / link resolve helpers). */
	mdFiles?: string[];
	/** Suggested filename stem (no extension). */
	defaultName: string;
	options: MarkdownExportOptions;
	/** Pre-resolved paper header; null when not a paper note or disabled. */
	paperHeader: MarkdownExportPaperHeader | null;
};

export type MarkdownExportResult =
	| { status: "cancelled" }
	| { status: "saved"; path: string; format: MarkdownExportFormat };

export type ResolvePaperHeaderInput = {
	filePath: string | null;
	vaultPath: string | null;
	paperMetaByRelPath: ReadonlyMap<string, PaperMetadata> | null | undefined;
};
