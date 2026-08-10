import { invokeApi } from "@/lib/core/ipc";
import { normalizeRelPath, toVaultRelative } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";

export { normalizeRelPath as normalizeVaultRel, toVaultRelative };

export type LinkFragment =
	| { kind: "heading"; path: string[] }
	| { kind: "block"; id: string }
	| { kind: "annotation"; id: string };

export type LinkResolutionStatus =
	| "resolved"
	| "missing"
	| "ambiguous"
	| "invalidFragment";

export type InternalLinkSyntax = "wikilink" | "markdown";

function isValidBlockId(id: string): boolean {
	return id.length > 0 && /^[\p{L}\p{N}-]+$/u.test(id);
}

/**
 * Annotation ids accept nanoid url-alphabet extras (`_`) and UUID hyphens.
 * Markdown `^block` ids stay stricter via {@link isValidBlockId}.
 */
export function isValidAnnotationId(id: string): boolean {
	return id.length > 0 && /^[\p{L}\p{N}_-]+$/u.test(id);
}

/**
 * Strip CommonMark-ish escapes (esp. `\_`) that otherwise break sugar split and
 * make the whole `path@id` look like a missing file / ambiguous stem match.
 */
export function unescapeMarkdownEscapes(raw: string): string {
	return raw.replace(/\\(.)/g, "$1");
}

/**
 * Strip CommonMark-ish escapes from annotation ids (esp. `\_`).
 */
export function normalizeAnnotationId(id: string): string {
	return unescapeMarkdownEscapes(id);
}

/**
 * Sugar `target@id` or same-note `[[@id]]` when the right side is a well-formed
 * annotation id. Uses the last `@` so path segments may contain `@`.
 */
export function splitAnnotationSugar(
	main: string,
): { target: string; id: string } | null {
	const at = main.lastIndexOf("@");
	if (at < 0) return null;
	// Unescape both sides: path stems often contain `_` (DOI-like paper folders)
	// and may have been corrupted by mdast `state.safe` on a prior save.
	const target = unescapeMarkdownEscapes(main.slice(0, at).trimEnd());
	const id = normalizeAnnotationId(main.slice(at + 1).trim());
	if (!isValidAnnotationId(id)) return null;
	return { target, id };
}

/** Parse `#heading`, `#^block`, `#@annotation`, or bare fragment text. */
export function parseWikiFragment(
	fragmentRaw: string,
): LinkFragment | undefined {
	const raw = fragmentRaw.trim();
	if (!raw) return undefined;
	if (raw.startsWith("^")) {
		return { kind: "block", id: raw.slice(1) };
	}
	if (raw.startsWith("@")) {
		return { kind: "annotation", id: normalizeAnnotationId(raw.slice(1)) };
	}
	return {
		kind: "heading",
		path: raw
			.split("#")
			.map((part) => part.trim())
			.filter(Boolean),
	};
}

/** Serialize a fragment for wikilink source (`#…` form, including sugar-friendly `@id`). */
export function formatWikiFragment(fragment: LinkFragment): string {
	if (fragment.kind === "block") return `^${fragment.id}`;
	if (fragment.kind === "annotation") return `@${fragment.id}`;
	return fragment.path.join("#");
}

/**
 * Suffix appended after a wiki target: `@id` for annotations, `#…` otherwise.
 * Empty when there is no fragment.
 */
export function wikiFragmentSuffix(fragment?: LinkFragment | null): string {
	if (!fragment) return "";
	return fragment.kind === "annotation"
		? `@${fragment.id}`
		: `#${formatWikiFragment(fragment)}`;
}

/**
 * Preferred user-facing link body: `target@id` for annotations, else `target#frag`.
 */
export function formatWikiLinkBody(
	targetRaw: string,
	fragment?: LinkFragment | null,
	alias?: string | null,
): string {
	let main = targetRaw;
	if (fragment?.kind === "annotation") {
		// Same-note form is `[[@id]]` (empty target).
		main = targetRaw ? `${targetRaw}@${fragment.id}` : `@${fragment.id}`;
	} else if (fragment) {
		main = targetRaw
			? `${targetRaw}#${formatWikiFragment(fragment)}`
			: `#${formatWikiFragment(fragment)}`;
	}
	return alias ? `${main}|${alias}` : main;
}

export type InternalLinkOccurrence = {
	source: string;
	targetRaw: string;
	syntax: InternalLinkSyntax;
	embed: boolean;
	displayText?: string;
	fragment?: LinkFragment;
	sourceRange: { start: number; end: number };
	fragmentRange?: { start: number; end: number };
	line: number;
	context?: string;
};

export type ResolvedLink = {
	occurrence: InternalLinkOccurrence;
	status: LinkResolutionStatus;
	targetPath?: string;
	candidates?: string[];
};

export type WikiEmbedResponse = {
	link: ResolvedLink;
	contentKind?: "markdown" | "image" | "pdf" | "annotation" | "unsupported";
	content?: string;
};

export type Backlink = ResolvedLink;

export type BacklinksResponse = {
	path: string;
	backlinks: Backlink[];
};

export type OutgoingLinksResponse = {
	path: string;
	outgoing: ResolvedLink[];
};

export type WikiSearchCandidate = {
	kind: "file" | "heading" | "block" | "alias" | "annotation";
	path: string;
	insertText: string;
	label: string;
	/** Context shown below the label: heading level or block text preview. */
	detail?: string;
	/** Display alias chosen by the user; `insertText` stays canonical. */
	alias?: string;
	fragment?: LinkFragment;
};

export type RebuildResult = {
	indexedFiles: number;
	edges: number;
	nodes: number;
};

export type WikiRenameRollback =
	| "not-needed"
	| "completed"
	| "manual-recovery-required";

export type WikiRenameSkipped = {
	path: string;
	reason: string;
};

export type WikiRenameResult = {
	movedPath: string;
	updatedSources: string[];
	skipped: WikiRenameSkipped[];
	rollback: WikiRenameRollback;
};

export type WikiRenameHeadingRequest = {
	path: string;
	headingPath: string[];
	headingLine: number;
	expectedContent: string;
	newText: string;
};

export type WikiRenameHeadingResult = {
	path: string;
	oldPath: string[];
	newPath: string[];
	updatedSources: string[];
	rollback: WikiRenameRollback;
};

/** Host-held pre-rename snapshot for an externally observed local move. */
export type WikiExternalRenamePreview = {
	candidateId: string;
	from: string;
	to: string;
	affectedSources: string[];
	skipped: WikiRenameSkipped[];
};

/** Whether an external rename preview contains any safe link rewrites to apply. */
export function externalRenameRepairNeeded(
	preview: Pick<WikiExternalRenamePreview, "affectedSources">,
): boolean {
	return preview.affectedSources.length > 0;
}

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

export type WikiRenameFailure = {
	code: string;
	rollback: WikiRenameRollback;
	paths?: string[];
};

export type WikiApiError = Error & { details?: unknown };

export function wikiRenameFailure(error: unknown): WikiRenameFailure | null {
	const details = (error as WikiApiError | undefined)?.details;
	if (
		!details ||
		typeof details !== "object" ||
		typeof (details as { code?: unknown }).code !== "string" ||
		typeof (details as { rollback?: unknown }).rollback !== "string"
	) {
		return null;
	}
	const paths = (details as { paths?: unknown }).paths;
	return {
		code: (details as { code: string }).code,
		rollback: (details as { rollback: WikiRenameRollback }).rollback,
		...(Array.isArray(paths) && paths.every((path) => typeof path === "string")
			? { paths }
			: {}),
	};
}

/** A failed external repair is zero-write only when the Host confirmed it. */
export function externalRenameRepairHadZeroWrites(error: unknown): boolean {
	return wikiRenameFailure(error)?.rollback === "not-needed";
}

async function invokeWikiApi<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	return invokeApi<T>(cmd, args, {
		desktopOnly: "Wiki index requires the Tauri desktop app.",
	});
}

/** Rename or move a local Vault path and repair resolved internal links. */
export async function moveVaultPath(
	vaultPath: string,
	fromRel: string,
	toRel: string,
	dirtyPaths: string[],
): Promise<WikiRenameResult> {
	return invokeWikiApi<WikiRenameResult>("wiki_move", {
		args: { vaultPath, fromRel, toRel, dirtyPaths },
	});
}

/** Explicitly rename one saved heading and repair resolved heading fragments. */
export async function renameWikiHeading(
	vaultPath: string,
	request: WikiRenameHeadingRequest,
	dirtyPaths: string[],
): Promise<WikiRenameHeadingResult> {
	return invokeWikiApi<WikiRenameHeadingResult>("wiki_rename_heading", {
		args: { vaultPath, ...request, dirtyPaths },
	});
}

/** Create a no-write repair candidate from a trustworthy external rename pair. */
export async function previewExternalRenameRepair(
	vaultPath: string,
	fromRel: string,
	toRel: string,
	dirtyPaths: string[],
): Promise<WikiExternalRenamePreview> {
	return invokeWikiApi<WikiExternalRenamePreview>(
		"wiki_external_rename_preview",
		{
			args: { vaultPath, fromRel, toRel, dirtyPaths },
		},
	);
}

/** Apply a previously previewed external rename repair after a fresh dirty check. */
export async function applyExternalRenameRepair(
	vaultPath: string,
	candidateId: string,
	dirtyPaths: string[],
): Promise<WikiRenameResult> {
	return invokeWikiApi<WikiRenameResult>("wiki_apply_external_rename_repair", {
		args: { vaultPath, candidateId, dirtyPaths },
	});
}

/** Whether a Markdown destination can be resolved inside the active Vault. */
export function isVaultLocalMarkdownLink(target: string): boolean {
	const value = target.trim().replace(/^<|>$/g, "");
	const lower = value.toLowerCase();
	return (
		value.length > 0 &&
		!value.startsWith("/") &&
		!lower.startsWith("//") &&
		!lower.startsWith("mailto:") &&
		!lower.startsWith("data:") &&
		!/^[a-z][a-z0-9+.-]*:/i.test(value)
	);
}

type Extracted = {
	targetRaw: string;
	alias?: string;
	embed?: boolean;
	fragment?: LinkFragment;
	line?: number;
	context?: string;
};

function parseLinkBody(
	body: string,
): { targetRaw: string; alias?: string; fragment?: LinkFragment } | null {
	const trimmed = body.trim();
	if (!trimmed) return null;
	const pipe = trimmed.indexOf("|");
	const main = (pipe >= 0 ? trimmed.slice(0, pipe) : trimmed).trim();
	const aliasRaw = pipe >= 0 ? trimmed.slice(pipe + 1).trim() : "";
	const alias = aliasRaw ? unescapeMarkdownEscapes(aliasRaw) : undefined;
	if (!main) return null;
	const hash = main.indexOf("#");
	if (hash >= 0) {
		const targetRaw = unescapeMarkdownEscapes(main.slice(0, hash).trim());
		const fragment = parseWikiFragment(main.slice(hash + 1));
		if (!targetRaw && !fragment) return null;
		return {
			targetRaw,
			alias,
			fragment,
		};
	}
	const sugar = splitAnnotationSugar(main);
	if (sugar) {
		return {
			targetRaw: sugar.target,
			alias,
			fragment: { kind: "annotation", id: sugar.id },
		};
	}
	return {
		targetRaw: unescapeMarkdownEscapes(main),
		alias,
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
			const embed = chars[i] === "!" && chars[i + 1] === "[";
			const opening = embed ? i + 1 : i;
			if (chars[opening] === "[" && chars[opening + 1] === "[") {
				let j = opening + 2;
				while (j + 1 < chars.length) {
					if (chars[j] === "]" && chars[j + 1] === "]") {
						const body = orig.slice(opening + 2, j).join("");
						const parsed = parseLinkBody(body);
						if (parsed) {
							const ctx = line.trim();
							results.push({
								...parsed,
								embed,
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
	const t = normalizeRelPath(targetRaw.trim());
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

/**
 * Minimal semantic resolver for the browser-only demo. Desktop production paths
 * call `wiki_resolve` in Rust; this duplicate is intentionally fixture-tested so
 * the demo never presents a more precise result than the Host can justify.
 */
export function resolveDemoWikiReference(
	sourcePath: string,
	linkText: string,
	documents: Array<{ path: string; content: string }>,
	syntax: InternalLinkSyntax = "wikilink",
): Pick<ResolvedLink, "status" | "targetPath" | "candidates"> & {
	fragment?: LinkFragment;
} {
	const parsedBody = parseLinkBody(linkText);
	const targetRaw = parsedBody?.targetRaw ?? linkText.trim();
	const fragment = parsedBody?.fragment;
	const key = (value: string) =>
		value.trim().replace(/\s+/g, " ").toLowerCase();
	const addExtensions = (value: string) => {
		const normalized = normalizeRelPath(value);
		if (!normalized) return [];
		return /\.(md|mdx|markdown)$/i.test(normalized)
			? [normalized]
			: [
					normalized,
					`${normalized}.md`,
					`${normalized}.mdx`,
					`${normalized}.markdown`,
				];
	};
	const sourceRelative = (value: string) => {
		const parts = sourcePath.split("/").slice(0, -1);
		for (const part of value.replace(/\\/g, "/").split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") {
				if (parts.length === 0) return null;
				parts.pop();
			} else {
				parts.push(part);
			}
		}
		return parts.join("/");
	};
	const aliasesFor = (content: string) => {
		const lines = content.split(/\r?\n/);
		if (lines[0]?.trim() !== "---") return [];
		const aliases: string[] = [];
		let reading = false;
		for (const line of lines.slice(1)) {
			const trimmed = line.trim();
			if (trimmed === "---" || trimmed === "...") break;
			if (trimmed.startsWith("aliases:")) {
				reading = true;
				const inline = trimmed.slice("aliases:".length).trim();
				if (inline.startsWith("[") && inline.endsWith("]")) {
					aliases.push(
						...inline
							.slice(1, -1)
							.split(",")
							.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
							.filter(Boolean),
					);
					reading = false;
				}
			} else if (reading && trimmed.startsWith("-")) {
				aliases.push(
					trimmed
						.slice(1)
						.trim()
						.replace(/^['"]|['"]$/g, ""),
				);
			} else if (trimmed && !/^\s/.test(line)) {
				reading = false;
			}
		}
		return aliases;
	};
	const choose = (matches: string[]) => {
		const unique = [...new Set(matches)].sort();
		return unique.length === 1
			? { path: unique[0] }
			: unique.length
				? { candidates: unique }
				: null;
	};
	let selected: { path?: string; candidates?: string[] } | null;
	if (!targetRaw) {
		selected = choose(
			documents
				.filter((document) => document.path === sourcePath)
				.map((document) => document.path),
		);
	} else {
		const candidates = addExtensions(targetRaw);
		const relativeTarget =
			syntax === "markdown" && !targetRaw.startsWith("/")
				? sourceRelative(targetRaw)
				: undefined;
		if (relativeTarget === null) {
			return { status: "missing", candidates: [] };
		}
		const relativeCandidates =
			typeof relativeTarget === "string" ? addExtensions(relativeTarget) : [];
		const matchCandidates = (values: string[], insensitive = false) =>
			choose(
				documents
					.filter((document) =>
						values.some((candidate) =>
							insensitive
								? candidate.toLowerCase() === document.path.toLowerCase()
								: candidate === document.path,
						),
					)
					.map((document) => document.path),
			);
		const exact =
			matchCandidates(relativeCandidates) ?? matchCandidates(candidates);
		const insensitive =
			matchCandidates(relativeCandidates, true) ??
			matchCandidates(candidates, true);
		const suffix = choose(
			documents
				.filter((document) =>
					candidates.some(
						(candidate) =>
							document.path.endsWith(`/${candidate}`) ||
							document.path === candidate,
					),
				)
				.map((document) => document.path),
		);
		const stem =
			targetRaw
				.split("/")
				.pop()
				?.replace(/\.(md|mdx|markdown)$/i, "") ?? targetRaw;
		const stemMatch = choose(
			documents
				.filter(
					(document) =>
						document.path
							.split("/")
							.pop()
							?.replace(/\.(md|mdx|markdown)$/i, "")
							.toLowerCase() === stem.toLowerCase(),
				)
				.map((document) => document.path),
		);
		const alias = choose(
			documents
				.filter((document) =>
					aliasesFor(document.content).some(
						(value) => key(value) === key(targetRaw),
					),
				)
				.map((document) => document.path),
		);
		selected = exact ?? insensitive ?? suffix ?? stemMatch ?? alias;
	}
	if (!selected) return { status: "missing", fragment };
	if (!selected.path)
		return { status: "ambiguous", candidates: selected.candidates, fragment };
	if (!fragment) return { status: "resolved", targetPath: selected.path };
	if (fragment.kind === "annotation") {
		return isValidAnnotationId(fragment.id)
			? { status: "resolved", targetPath: selected.path, fragment }
			: {
					status: "invalidFragment",
					targetPath: selected.path,
					fragment,
				};
	}
	if (fragment.kind === "block" && !isValidBlockId(fragment.id)) {
		return {
			status: "invalidFragment",
			targetPath: selected.path,
			fragment,
		};
	}
	const content =
		documents.find((document) => document.path === selected.path)?.content ??
		"";
	const lines = content.split(/\r?\n/);
	const frontmatterEnd =
		lines[0]?.trim() === "---"
			? lines.findIndex(
					(line, index) =>
						index > 0 && (line.trim() === "---" || line.trim() === "..."),
				)
			: -1;
	let inFence = false;
	const semanticLines = lines.filter((line, index) => {
		if (frontmatterEnd >= 0 && index <= frontmatterEnd) return false;
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = !inFence;
			return false;
		}
		return !inFence;
	});
	const matches =
		fragment.kind === "block"
			? semanticLines.filter((line) =>
					new RegExp(`\\^${fragment.id}(?=\\s*$)`).test(line),
				).length
			: (() => {
					const stack: Array<{ level: number; text: string }> = [];
					return semanticLines
						.flatMap((line) => {
							const match = line.trimStart().match(/^(#{1,6}) (.*)$/);
							if (!match) return [];
							const level = match[1].length;
							const text = match[2]
								.trimStart()
								.trimEnd()
								.replace(/#+$/, "")
								.trimEnd();
							if (!text) return [];
							while (
								stack.length > 0 &&
								stack[stack.length - 1].level >= level
							) {
								stack.pop();
							}
							stack.push({ level, text });
							return [stack.map((heading) => heading.text)];
						})
						.filter((path) => {
							if (fragment.kind !== "heading") return false;
							const expected = fragment.path.map(key);
							const actual = path.map(key);
							const suffix = actual.slice(-expected.length);
							return (
								expected.length > 0 &&
								suffix.length === expected.length &&
								suffix.every((part, index) => part === expected[index])
							);
						}).length;
				})();
	return matches === 1
		? { status: "resolved", targetPath: selected.path, fragment }
		: matches > 1
			? { status: "ambiguous", targetPath: selected.path, fragment }
			: { status: "invalidFragment", targetPath: selected.path, fragment };
}

/** Protocol for preview-only markdown links generated from `[[wikilinks]]`. */
export const WIKI_HREF_PREFIX = "agentero-wiki:";

export type WikiNavTarget = {
	targetRaw: string;
	/** Resolved vault-relative path when exists */
	path: string | null;
	status: LinkResolutionStatus;
	fragment?: LinkFragment;
};

/** Navigation payload for an already-resolved link (link / wikilink / embed). */
export function navFromResolvedLink(resolved: ResolvedLink): WikiNavTarget {
	return {
		targetRaw: resolved.occurrence.targetRaw,
		path: resolved.targetPath ?? null,
		status: resolved.status,
		fragment: resolved.occurrence.fragment,
	};
}

/**
 * Select the file-level destination for a link click.
 *
 * An invalid fragment still has a valid target file, so navigation degrades to
 * that file without forwarding the stale heading/block intent.
 */
export function wikiNavigationDestination(nav: WikiNavTarget): {
	path: string;
	fragment?: LinkFragment;
	warning?: "invalidFragment";
} | null {
	if (!nav.path) return null;
	if (nav.status === "resolved") {
		return { path: nav.path, fragment: nav.fragment };
	}
	if (nav.status === "invalidFragment") {
		return { path: nav.path, warning: "invalidFragment" };
	}
	return null;
}

/** Encode navigation payload into a markdown-safe href. */
export function encodeWikiHref(nav: WikiNavTarget): string {
	const payload = [
		nav.status,
		encodeURIComponent(nav.targetRaw),
		encodeURIComponent(nav.path ?? ""),
		encodeURIComponent(nav.fragment ? JSON.stringify(nav.fragment) : ""),
	].join("/");
	return `${WIKI_HREF_PREFIX}${payload}`;
}

export function parseWikiHref(href: string): WikiNavTarget | null {
	if (!href.startsWith(WIKI_HREF_PREFIX)) return null;
	const rest = href.slice(WIKI_HREF_PREFIX.length);
	const parts = rest.split("/");
	if (parts.length < 3) return null;
	const [statusRaw, rawTarget, rawPath, rawFragment] = parts;
	const targetRaw = decodeURIComponent(rawTarget ?? "");
	const path = decodeURIComponent(rawPath ?? "");
	const fragmentRaw = decodeURIComponent(rawFragment ?? "");
	if (!targetRaw && !fragmentRaw) return null;
	return {
		targetRaw,
		path: path || null,
		status: isLinkResolutionStatus(statusRaw) ? statusRaw : "missing",
		fragment: fragmentRaw
			? (JSON.parse(fragmentRaw) as LinkFragment)
			: undefined,
	};
}

function isLinkResolutionStatus(
	value: string | undefined,
): value is LinkResolutionStatus {
	return (
		value === "resolved" ||
		value === "missing" ||
		value === "ambiguous" ||
		value === "invalidFragment"
	);
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
								status: resolved ? "resolved" : "missing",
								fragment: parsed.fragment,
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
	const t = normalizeRelPath(targetRaw.trim());
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
		normalizeRelPath(targetRaw)
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
	return invokeWikiApi<BacklinksResponse>("graph_get_backlinks", {
		vaultPath,
		path,
	});
}

export async function getOutgoingLinks(
	vaultPath: string | null,
	path: string,
): Promise<OutgoingLinksResponse> {
	if (!path) return { path: "", outgoing: [] };
	if (!vaultPath || !isTauri()) {
		return { path: toVaultRelative(vaultPath, path), outgoing: [] };
	}
	return invokeWikiApi<OutgoingLinksResponse>("wiki_get_outgoing", {
		vaultPath,
		path,
	});
}

export async function resolveWikiReference(
	vaultPath: string | null,
	sourcePath: string,
	linkText: string,
	syntax: InternalLinkSyntax = "wikilink",
): Promise<ResolvedLink | null> {
	if (!vaultPath || !isTauri()) return null;
	const response = await invokeWikiApi<{ link: ResolvedLink }>("wiki_resolve", {
		vaultPath,
		sourcePath,
		linkText,
		syntax,
	});
	return response.link;
}

export async function readWikiEmbed(
	vaultPath: string | null,
	sourcePath: string,
	linkText: string,
): Promise<WikiEmbedResponse> {
	return invokeWikiApi<WikiEmbedResponse>("wiki_embed_read", {
		vaultPath,
		sourcePath,
		linkText,
	});
}

export async function searchWikiLinks(
	vaultPath: string | null,
	query: string,
	scope?: {
		path?: string | null;
		kind?: WikiSearchCandidate["kind"] | null;
	},
): Promise<WikiSearchCandidate[]> {
	if (!vaultPath || !isTauri()) return [];
	return invokeWikiApi<WikiSearchCandidate[]>("wiki_search", {
		vaultPath,
		query,
		path: scope?.path ?? null,
		kind: scope?.kind ?? null,
	});
}

export async function rebuildWikiIndex(
	vaultPath: string,
): Promise<RebuildResult> {
	return invokeWikiApi<RebuildResult>("graph_rebuild", { vaultPath });
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
	return invokeWikiApi<GraphResponse>("graph_get_graph", {
		vaultPath,
		center,
		depth,
	});
}
