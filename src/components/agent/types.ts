import type { ReactNode } from "react";
import type { PromptImage } from "@/lib/agent/api";
import type { SelectionContext } from "@/lib/agent/selection-store";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import type { PaperMetadata, PaperTreeLabelMode } from "@/lib/paper";

/** Follow-up prompts waiting until the active run finishes. */
export type QueuedPrompt = {
	id: string;
	text: string;
	workflow?: string;
	/** Vault paths frozen when the user queued the message. */
	contextPaths: string[];
	/** Skill ids frozen when the user queued the message. */
	skillIds: string[];
	/** Selection chips frozen when the user queued the message. */
	selections: SelectionContext[];
	/** Visual PDF annotation drafts frozen when the user queued the message. */
	visualDrafts: PdfVisualDraft[];
	/** Composer image attachments frozen when the user queued the message. */
	images?: PromptImage[];
};

export type AgentPanelProps = {
	vaultPath: string | null;
	selectedPath?: string | null;
	/**
	 * Catalog title for the focused paper (chip label prefers this over folder name).
	 */
	selectedPaperTitle?: string | null;
	vaultMarkdownPaths?: string[];
	/**
	 * Vault-relative files supported by the voice-defense snapshot pipeline.
	 */
	vaultDefenseMaterialPaths?: string[];
	/**
	 * Vault-relative directory paths from the file tree.
	 * Used so context chips show a folder icon for org / notes dirs.
	 */
	vaultDirectoryPaths?: string[];
	/**
	 * Vault-relative **paper** folder paths (marker-based under `papers/`).
	 * Chips use the same ScrollText paper icon as the file tree.
	 */
	vaultPaperPaths?: string[];
	/**
	 * Catalog rows by vault-relative paper path — same source as the file tree.
	 * Used so `@` / chips show paper titles per `paperTreeLabelMode`.
	 */
	paperMetaByRelPath?: ReadonlyMap<string, PaperMetadata> | null;
	/** Settings → General: paper labels in file tree (display-only). */
	paperTreeLabelMode?: PaperTreeLabelMode;
	className?: string;
	headerActions?: ReactNode;
	autoFocus?: boolean;
	title?: string;
	/** Open Settings → Agent (ACP backend registry). */
	onOpenAgentSettings?: () => void;
	/**
	 * Open a chat source path (vault-relative paper/file, or http URL).
	 * Paper paths should open the paper workspace (PDF + NOTES).
	 */
	onOpenSource?: (source: string) => void;
};
