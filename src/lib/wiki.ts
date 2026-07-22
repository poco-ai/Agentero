import { ipc } from "@/lib/ipc";
import { isTauri } from "@/lib/tauri";

export type Backlink = {
	source: string;
	targetRaw: string;
	alias?: string;
	context?: string;
	line?: number;
};

export type BacklinksResponse = {
	path: string;
	backlinks: Backlink[];
};

export type RebuildResult = {
	indexedFiles: number;
	edges: number;
	nodes: number;
};

export type GraphNodeType = "paper" | "note" | "index" | "stub";

export type GraphNode = {
	id: string;
	label: string;
	type: GraphNodeType;
	path?: string;
};

export type GraphEdge = {
	id: string;
	source: string;
	target: string;
	targetRaw?: string;
};

export type GraphResponse = {
	nodes: GraphNode[];
	edges: GraphEdge[];
	center?: string | null;
	depth: number;
};

async function invokeApi<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	if (!isTauri()) {
		throw new Error("Wiki index requires the Tauri desktop app.");
	}
	return ipc<T>(cmd, args);
}

/** Normalize vault-relative path (forward slashes, no leading ./). */
export function normalizeVaultRel(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Strip vault root prefix when path is absolute. */
export function toVaultRelative(
	vaultPath: string | null,
	path: string,
): string {
	const n = normalizeVaultRel(path);
	if (!vaultPath) {
		return n;
	}
	const root = normalizeVaultRel(vaultPath);
	if (n === root) return "";
	if (n.startsWith(`${root}/`)) return n.slice(root.length + 1);
	return n;
}

type Extracted = {
	targetRaw: string;
	alias?: string;
	heading?: string;
	line?: number;
	context?: string;
};

function parseLinkBody(
	body: string,
): { targetRaw: string; alias?: string; heading?: string } | null {
	const trimmed = body.trim();
	if (!trimmed) return null;
	const pipe = trimmed.indexOf("|");
	const main = (pipe >= 0 ? trimmed.slice(0, pipe) : trimmed).trim();
	const aliasRaw = pipe >= 0 ? trimmed.slice(pipe + 1).trim() : "";
	if (!main) return null;
	const hash = main.indexOf("#");
	const targetRaw = (hash >= 0 ? main.slice(0, hash) : main).trim();
	const heading = hash >= 0 ? main.slice(hash + 1).trim() : "";
	if (!targetRaw) return null;
	return {
		targetRaw,
		alias: aliasRaw || undefined,
		heading: heading || undefined,
	};
}

function maskInlineCode(line: string): string {
	const chars = [...line];
	const out: string[] = [];
	let i = 0;
	while (i < chars.length) {
		if (chars[i] === "`") {
			const start = i;
			i += 1;
			while (i < chars.length && chars[i] !== "`") i += 1;
			if (i < chars.length) {
				for (let k = start; k <= i; k++) out.push(" ");
				i += 1;
			} else {
				for (let k = start; k < chars.length; k++) out.push(" ");
				break;
			}
		} else {
			out.push(chars[i]);
			i += 1;
		}
	}
	return out.join("");
}

/** Client-side extract for demo / offline (mirrors Rust extract rules). */
export function extractWikilinks(md: string): Extracted[] {
	const results: Extracted[] = [];
	let inFence = false;
	const lines = md.split(/\r?\n/);
	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx];
		const lineNo = idx + 1;
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const searchable = maskInlineCode(line);
		const chars = [...searchable];
		const orig = [...line];
		let i = 0;
		while (i + 1 < chars.length) {
			if (chars[i] === "[" && chars[i + 1] === "[") {
				let j = i + 2;
				while (j + 1 < chars.length) {
					if (chars[j] === "]" && chars[j + 1] === "]") {
						const body = orig.slice(i + 2, j).join("");
						const parsed = parseLinkBody(body);
						if (parsed) {
							const ctx = line.trim();
							results.push({
								...parsed,
								line: lineNo,
								context: ctx || undefined,
							});
						}
						i = j + 2;
						break;
					}
					j += 1;
				}
				if (j + 1 >= chars.length) break;
			} else {
				i += 1;
			}
		}
	}
	return results;
}

/** Resolve a wikilink target against vault-relative Markdown paths. */
export function resolveWikiTarget(
	targetRaw: string,
	files: string[],
): string | null {
	const t = normalizeVaultRel(targetRaw.trim());
	if (!t || files.length === 0) return null;
	const candidates = [t, `${t}.md`, `${t}.mdx`, `${t}.markdown`];
	for (const c of candidates) {
		const hit = files.find((f) => f === c);
		if (hit) return hit;
	}
	for (const c of candidates) {
		const hit = files.find((f) => f.toLowerCase() === c.toLowerCase());
		if (hit) return hit;
	}
	const suffixHits: string[] = [];
	for (const c of candidates) {
		const needle = `/${c}`;
		for (const f of files) {
			if ((f === c || f.endsWith(needle)) && !suffixHits.includes(f)) {
				suffixHits.push(f);
			}
		}
	}
	if (suffixHits.length === 1) return suffixHits[0];
	if (suffixHits.length > 1) return null;
	const stem = (p: string) => {
		const base = p.split("/").pop() ?? p;
		return base.replace(/\.(md|mdx|markdown)$/i, "");
	};
	const want = stem(t);
	const stemHits = files.filter(
		(f) => stem(f).toLowerCase() === want.toLowerCase(),
	);
	if (stemHits.length === 1) return stemHits[0];
	return null;
}

/** Protocol for preview-only markdown links generated from `[[wikilinks]]`. */
export const WIKI_HREF_PREFIX = "agentero-wiki:";

export type WikiNavTarget = {
	targetRaw: string;
	/** Resolved vault-relative path when exists */
	path: string | null;
	exists: boolean;
	heading?: string;
};

/** Encode navigation payload into a markdown-safe href. */
export function encodeWikiHref(nav: WikiNavTarget): string {
	const payload = [
		nav.exists ? "1" : "0",
		encodeURIComponent(nav.targetRaw),
		encodeURIComponent(nav.path ?? ""),
		encodeURIComponent(nav.heading ?? ""),
	].join("/");
	return `${WIKI_HREF_PREFIX}${payload}`;
}

export function parseWikiHref(href: string): WikiNavTarget | null {
	if (!href.startsWith(WIKI_HREF_PREFIX)) return null;
	const rest = href.slice(WIKI_HREF_PREFIX.length);
	const parts = rest.split("/");
	if (parts.length < 3) return null;
	const [existsFlag, rawTarget, rawPath, rawHeading] = parts;
	const targetRaw = decodeURIComponent(rawTarget ?? "");
	const path = decodeURIComponent(rawPath ?? "");
	const heading = decodeURIComponent(rawHeading ?? "");
	if (!targetRaw) return null;
	return {
		targetRaw,
		path: path || null,
		exists: existsFlag === "1",
		heading: heading || undefined,
	};
}

function escapeMdLabel(label: string): string {
	return label.replace(/[[\]]/g, "\\$&");
}

/**
 * Rewrite `[[wikilinks]]` to markdown links for Plate preview.
 * Code fences / inline code are left untouched (same rules as extract).
 */
export function rewriteWikilinksForPreview(
	md: string,
	files: string[],
): string {
	let inFence = false;
	const lines = md.split(/\r?\n/);
	const out: string[] = [];

	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		const searchable = maskInlineCode(line);
		const chars = [...searchable];
		const orig = [...line];
		let i = 0;
		let rebuilt = "";
		while (i < chars.length) {
			if (i + 1 < chars.length && chars[i] === "[" && chars[i + 1] === "[") {
				let j = i + 2;
				let found = false;
				while (j + 1 < chars.length) {
					if (chars[j] === "]" && chars[j + 1] === "]") {
						const body = orig.slice(i + 2, j).join("");
						const parsed = parseLinkBody(body);
						if (parsed) {
							const resolved = resolveWikiTarget(parsed.targetRaw, files);
							const label = escapeMdLabel(parsed.alias ?? parsed.targetRaw);
							const href = encodeWikiHref({
								targetRaw: parsed.targetRaw,
								path: resolved,
								exists: Boolean(resolved),
								heading: parsed.heading,
							});
							rebuilt += `[${label}](${href})`;
						} else {
							rebuilt += orig.slice(i, j + 2).join("");
						}
						i = j + 2;
						found = true;
						break;
					}
					j += 1;
				}
				if (!found) {
					rebuilt += orig.slice(i).join("");
					break;
				}
			} else {
				rebuilt += orig[i];
				i += 1;
			}
		}
		out.push(rebuilt);
	}

	return out.join("\n");
}

/** Default path for a missing wikilink (Obsidian-ish: notes/<name>.md). */
export function missingNotePath(targetRaw: string): string {
	const t = normalizeVaultRel(targetRaw.trim());
	if (!t) return "notes/untitled.md";
	if (t.includes("/")) {
		return /\.(md|mdx|markdown)$/i.test(t) ? t : `${t}.md`;
	}
	const stem = t.replace(/\.(md|mdx|markdown)$/i, "");
	const slug =
		stem
			.replace(/[^\w\u4e00-\u9fff.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "untitled";
	return `notes/${slug}.md`;
}

/** Seed content for a newly created note. */
export function newNoteMarkdown(targetRaw: string): string {
	const title =
		normalizeVaultRel(targetRaw)
			.split("/")
			.pop()
			?.replace(/\.(md|mdx|markdown)$/i, "") || "Untitled";
	return `# ${title}\n\n`;
}

export async function getBacklinks(
	vaultPath: string | null,
	path: string,
): Promise<BacklinksResponse> {
	if (!path) {
		return { path: "", backlinks: [] };
	}
	if (!vaultPath || !isTauri()) {
		return { path: toVaultRelative(vaultPath, path), backlinks: [] };
	}
	return invokeApi<BacklinksResponse>("graph_get_backlinks", {
		vaultPath,
		path,
	});
}

export async function rebuildWikiIndex(
	vaultPath: string,
): Promise<RebuildResult> {
	return invokeApi<RebuildResult>("graph_rebuild", { vaultPath });
}

export async function getGraph(
	vaultPath: string | null,
	opts?: { center?: string | null; depth?: number | null },
): Promise<GraphResponse> {
	const depth = opts?.depth ?? 2;
	const center = opts?.center ?? null;
	if (!vaultPath || !isTauri()) {
		return { nodes: [], edges: [], center: null, depth };
	}
	return invokeApi<GraphResponse>("graph_get_graph", {
		vaultPath,
		center,
		depth,
	});
}
