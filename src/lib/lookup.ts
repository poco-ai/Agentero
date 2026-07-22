/**
 * Magic-wand identifier import via Host `lookup_import`.
 * Always downloads PDF; arXiv also downloads and unpacks LaTeX into `source/`.
 * Translator base URL comes from Settings (`translatorBaseUrl`).
 * @see docs/backend/identifier-lookup.md
 */
import { open } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import { type AppSettings, DEFAULT_TRANSLATOR_BASE_URL } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";

export type LookupAddResult = {
	paperDir: string;
	path: string;
	id: string;
	title: string;
	usedTranslator: boolean;
	translatorBaseUrl: string;
	/** Local PDF present after import download. */
	pdf?: boolean;
	/** Local TeX present after import download. */
	tex?: boolean;
	paperMd?: boolean;
	assetMessages?: string[];
};

export type PaperAssetsDownloadResult = {
	pdf: boolean;
	tex: boolean;
	paperMd?: boolean;
	messages: string[];
};

export type PaperParseBodyResult = {
	paperMd: boolean;
	bodySource?: string;
	bodyQuality?: string;
	messages: string[];
};

type HostLookupResult = {
	paperDir: string;
	path: string;
	id: string;
	title: string;
	usedTranslator: boolean;
	translatorBaseUrl: string;
	pdf?: boolean;
	tex?: boolean;
	paperMd?: boolean;
	assetMessages?: string[];
};

function resolveTranslatorBaseUrl(
	settings: AppSettings,
	override?: string,
): string {
	const raw =
		override?.trim() ||
		settings.translatorBaseUrl?.trim() ||
		DEFAULT_TRANSLATOR_BASE_URL;
	return raw.replace(/\/+$/, "");
}

function toLookupAddResult(d: HostLookupResult): LookupAddResult {
	return {
		paperDir: d.paperDir,
		path: d.path,
		id: d.id,
		title: d.title,
		usedTranslator: d.usedTranslator,
		translatorBaseUrl: d.translatorBaseUrl,
		pdf: d.pdf,
		tex: d.tex,
		paperMd: d.paperMd,
		assetMessages: d.assetMessages,
	};
}

/**
 * Add a paper by identifier/URL into `vaultRoot/parentDir/<id>/`.
 * Host calls Translator at Settings `translatorBaseUrl`
 * (default https://translator.philfan.cn); falls back to arXiv API
 * when Runtime is down and input is an arXiv id.
 * Always mirrors PDF into `source/`; arXiv also unpacks e-print TeX.
 */
export async function addPaperByIdentifier(opts: {
	vaultRoot: string;
	/** Vault-relative, e.g. `papers` or `papers/nlp` */
	parentDir: string;
	text: string;
	settings: AppSettings;
	/** Override settings URL for this call */
	translatorBaseUrl?: string;
	progressTaskId?: string;
}): Promise<LookupAddResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:lookup.desktopOnly"));
	}

	const text = opts.text.trim();
	if (!text) {
		throw new Error(i18n.t("sidebar:lookup.invalidId"));
	}

	const translatorBaseUrl = resolveTranslatorBaseUrl(
		opts.settings,
		opts.translatorBaseUrl,
	);

	const result = await ipc<HostLookupResult>("lookup_import", {
		args: {
			vaultPath: opts.vaultRoot,
			parentDir: opts.parentDir.replace(/\\/g, "/"),
			text,
			translatorBaseUrl,
			taskId: opts.progressTaskId,
		},
	});

	return toLookupAddResult(result);
}

/**
 * Download PDF (+ arXiv LaTeX) for a paper folder missing local assets.
 * `paperPath` is vault-relative (e.g. `papers/1706.03762`).
 */
export async function downloadPaperAssets(opts: {
	vaultRoot: string;
	paperPath: string;
	progressTaskId?: string;
}): Promise<PaperAssetsDownloadResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:lookup.desktopOnly"));
	}
	return ipc<PaperAssetsDownloadResult>("paper_download_assets", {
		args: {
			vaultPath: opts.vaultRoot,
			path: opts.paperPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
			taskId: opts.progressTaskId,
		},
	});
}

/**
 * Parse local PDF → PAPER.md via liteparse when the paper has no TeX.
 * `paperPath` is vault-relative (e.g. `papers/1706.03762`).
 */
export async function parsePaperBody(opts: {
	vaultRoot: string;
	paperPath: string;
	force?: boolean;
}): Promise<PaperParseBodyResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:lookup.desktopOnly"));
	}
	return ipc<PaperParseBodyResult>("paper_parse_body", {
		args: {
			vaultPath: opts.vaultRoot,
			path: opts.paperPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
			force: opts.force ?? false,
		},
	});
}

type HostLocalPdfImportResult = {
	papers: HostLookupResult[];
	errors?: string[];
};

export type LocalPdfImportResult = {
	papers: LookupAddResult[];
	/** `"<file>: <reason>"` for each PDF that failed to import. */
	errors: string[];
};

/** Per-file metadata for local PDF import (confirm dialog / host overrides). */
export type LocalPdfImportEntry = {
	filePath: string;
	title?: string;
	authors?: string[];
	year?: number;
	id?: string;
};

/**
 * Import local PDF file(s) into `vaultRoot/parentDir/<slug>/` (copy + catalog + liteparse).
 * Opens a native PDF picker unless `entries` or `filePaths` is provided.
 * Returns null when the user cancels the picker.
 */
export async function importLocalPdfs(opts: {
	vaultRoot: string;
	/** Vault-relative, e.g. `papers` or `papers/nlp` */
	parentDir: string;
	/** Absolute paths (skip native picker when non-empty; no metadata overrides). */
	filePaths?: string[];
	/** Preferred: path + optional title/authors/year/id from the confirm dialog. */
	entries?: LocalPdfImportEntry[];
}): Promise<LocalPdfImportResult | null> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:lookup.desktopOnly"));
	}
	let entries = (opts.entries ?? [])
		.map((e) => ({ ...e, filePath: e.filePath.trim() }))
		.filter((e) => e.filePath);
	if (!entries.length) {
		let filePaths = (opts.filePaths ?? []).map((p) => p.trim()).filter(Boolean);
		if (!filePaths.length) {
			const selected = await open({
				multiple: true,
				filters: [{ name: "PDF", extensions: ["pdf"] }],
			});
			if (!selected) return null;
			filePaths = (Array.isArray(selected) ? selected : [selected]).filter(
				(p): p is string => Boolean(p),
			);
		}
		entries = filePaths.map((filePath) => ({ filePath }));
	}
	if (!entries.length) return null;

	const result = await ipc<HostLocalPdfImportResult>("paper_import_local_pdf", {
		args: {
			vaultPath: opts.vaultRoot,
			parentDir: opts.parentDir.replace(/\\/g, "/"),
			filePaths: [],
			entries,
		},
	});
	return {
		papers: result.papers.map(toLookupAddResult),
		errors: result.errors ?? [],
	};
}
