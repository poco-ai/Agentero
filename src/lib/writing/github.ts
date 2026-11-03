/**
 * The GitHub repository bound to one writing project.
 * Every project under `thesis/` keeps its own repository. The address stays on
 * this computer and is not written into the manuscript.
 */

import {
	readJsonStorage,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";

export const WRITING_GITHUB_KEY = "agentero.writing.github.v1";

export type WritingGitHubLink = {
	remote: string;
	branch: string;
	label: string;
};

type StoredLink = {
	remote?: unknown;
	branch?: unknown;
};

/** Older builds stored one repository for the whole `thesis/` shelf. */
type StoredVault = StoredLink & {
	projects?: unknown;
};

export function parseGitHubRemote(
	input: string,
): { remote: string; label: string } | null {
	const text = input.trim().replace(/\/+$/, "");
	if (!text || /[?#\s]/.test(text)) return null;
	let rest = "";
	if (text.startsWith("https://github.com/")) {
		rest = text.slice("https://github.com/".length);
	} else if (text.startsWith("git@github.com:")) {
		rest = text.slice("git@github.com:".length);
	} else if (text.startsWith("github.com/")) {
		rest = text.slice("github.com/".length);
	} else {
		return null;
	}
	if (rest.endsWith(".git")) rest = rest.slice(0, -4);
	const parts = rest.split("/");
	if (parts.length !== 2) return null;
	const [owner, repo] = parts;
	if (!owner || !repo || !isGitHubName(owner) || !isGitHubName(repo))
		return null;
	return {
		remote: `https://github.com/${owner}/${repo}.git`,
		label: `${owner}/${repo}`,
	};
}

export function normalizeBranch(input: string): string | null {
	const text = input.trim();
	if (
		!text ||
		text.length > 100 ||
		text.startsWith("-") ||
		text.startsWith("/") ||
		text.endsWith("/") ||
		text.includes("..") ||
		text.includes("@")
	) {
		return null;
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(text)) return null;
	return text;
}

/** Read one stored entry as a usable link; unknown shapes are ignored. */
function parseLink(item: StoredLink | undefined): WritingGitHubLink | null {
	if (!item || typeof item.remote !== "string") return null;
	if (typeof item.branch !== "string") return null;
	const parsed = parseGitHubRemote(item.remote);
	const branch = normalizeBranch(item.branch);
	if (!parsed || !branch) return null;
	return { remote: parsed.remote, branch, label: parsed.label };
}

function readProjects(item: StoredVault): Record<string, StoredLink> {
	if (!item.projects || typeof item.projects !== "object") return {};
	return item.projects as Record<string, StoredLink>;
}

/**
 * Repository bound to one project, keyed by its vault-relative folder
 * (`thesis/<project>`, or `thesis` for an older flat vault). The shelf key
 * still reads the single repository older builds stored.
 */
export function readWritingGitHub(
	vaultPath: string,
	project: string,
	storage?: StorageLike | null,
): WritingGitHubLink | null {
	const raw = readJsonStorage<Record<string, StoredVault>>(
		WRITING_GITHUB_KEY,
		{},
		storage,
	);
	const item = raw[vaultPath];
	if (!item) return null;
	const stored = parseLink(readProjects(item)[project]);
	if (stored) return stored;
	return project === "thesis" ? parseLink(item) : null;
}

export function writeWritingGitHub(
	vaultPath: string,
	project: string,
	link: WritingGitHubLink,
	storage?: StorageLike | null,
): void {
	const raw = readJsonStorage<Record<string, StoredVault>>(
		WRITING_GITHUB_KEY,
		{},
		storage,
	);
	const item = raw[vaultPath] ?? {};
	raw[vaultPath] = {
		...item,
		projects: { ...readProjects(item), [project]: link },
	};
	writeJsonStorage(WRITING_GITHUB_KEY, raw, storage);
}

function isGitHubName(name: string): boolean {
	if (!name || name.length > 100 || name === "." || name === "..") return false;
	return /^[A-Za-z0-9._-]+$/.test(name);
}
