import {
	lstat,
	mkdir,
	readDir,
	readFile,
	remove,
	rename,
	writeFile,
} from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import { basenameOf, dirnameOf, normalizePath } from "@/lib/core/path";
import { texBuildOptions } from "@/lib/tex/config";
import { getLatexArtifacts } from "@/lib/tex/host";
import { joinVaultPath } from "@/lib/vault/path";
import { isWritingSourceName } from "../files";
import {
	type ExplicitWritingProject,
	WRITING_MANIFEST,
} from "../project-manifest";
import { maxProjectFiles, writingPath } from "./protocol/contracts";

export type DiskFile = { path: string } & (
	| { kind: "directory" }
	| { kind: "text"; text: string }
	| { kind: "asset"; sha256: string }
);
type CachedFile = { fingerprint: string; file: DiskFile };

const temporary = /^agentero\.(?:project|cloud)\.[a-f0-9-]+\.tmp$/i;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const recoveryDirectory = "Agentero Conflicts";

export async function sha256(data: Uint8Array) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

function excluded(name: string, directory: boolean) {
	return (
		name.toLowerCase() === WRITING_MANIFEST ||
		name === recoveryDirectory ||
		temporary.test(name) ||
		(name.startsWith(".") && !directory) ||
		(directory
			? !isWritingSourceName("directory", name)
			: !isWritingSourceName("file", name) &&
				!name.toLowerCase().endsWith(".pdf"))
	);
}

async function inspect(
	path: string,
	rel: string,
	cache: Map<string, CachedFile>,
): Promise<DiskFile> {
	const meta = await lstat(path);
	if (!meta.isFile || meta.isSymlink)
		throw new Error(i18n.t("sidebar:writing.cloudUnsafePath"));
	if (meta.size > 32 * 1024 * 1024)
		throw new Error(i18n.t("sidebar:writing.cloudLargeFile", { path: rel }));
	const fingerprint = `${meta.size}:${meta.mtime?.getTime() ?? -1}`;
	const known = cache.get(rel);
	if (known?.fingerprint === fingerprint && meta.mtime) return known.file;
	const bytes = await readFile(path);
	let file: DiskFile;
	try {
		// Binary content remains external to the Yjs document.
		if (
			bytes.includes(0) ||
			/\.(?:pdf|png|jpe?g|gif|webp|avif|tiff?|zip|otf|ttf|woff2?)$/i.test(rel)
		)
			throw new Error();
		const text = decoder.decode(bytes);
		if (bytes.length > 8 * 1024 * 1024) throw new Error();
		file = { kind: "text", path: rel, text };
	} catch {
		file = { kind: "asset", path: rel, sha256: await sha256(bytes) };
	}
	cache.set(rel, { fingerprint, file });
	return file;
}

export async function scanWritingDisk(
	project: ExplicitWritingProject,
	cache = new Map<string, CachedFile>(),
) {
	const result = new Map<string, DiskFile>();
	const pending = [""];
	const output = normalizePath(
		(
			await getLatexArtifacts(
				project.root,
				texBuildOptions(project.root),
			).catch(() => null)
		)?.pdfPath ?? project.root.replace(/\.tex$/i, ".pdf"),
	);
	while (pending.length > 0) {
		const parent = pending.pop();
		if (parent === undefined) break;
		const directory = parent
			? joinVaultPath(project.directory, parent)
			: project.directory;
		for (const entry of await readDir(directory)) {
			if (parent && entry.name.toLowerCase() === WRITING_MANIFEST)
				throw new Error(i18n.t("sidebar:writing.nestedProject"));
			if (entry.isSymlink && !entry.name.startsWith("."))
				throw new Error(i18n.t("sidebar:writing.cloudUnsafePath"));
			if (excluded(entry.name, entry.isDirectory)) continue;
			const rel = parent ? `${parent}/${entry.name}` : entry.name;
			const absolute = joinVaultPath(project.directory, rel);
			if (!entry.isDirectory && normalizePath(absolute) === output) continue;
			writingPath.parse(rel);
			if (result.size >= maxProjectFiles)
				throw new Error(i18n.t("sidebar:writing.cloudLargeProject"));
			if (entry.isDirectory) {
				result.set(rel, { path: rel, kind: "directory" });
				pending.push(rel);
			} else if (entry.isFile) {
				result.set(rel, await inspect(absolute, rel, cache));
			}
		}
	}
	for (const path of cache.keys()) if (!result.has(path)) cache.delete(path);
	return result;
}

export type DiskCache = Map<string, CachedFile>;

export function sameDiskFile(a?: DiskFile, b?: DiskFile) {
	if (!a || !b) return a === b;
	if (a.kind !== b.kind) return false;
	return (
		a.kind === "directory" ||
		(a.kind === "text" && b.kind === "text" && a.text === b.text) ||
		(a.kind === "asset" && b.kind === "asset" && a.sha256 === b.sha256)
	);
}

async function existing(path: string) {
	// readDir distinguishes a missing entry from a permission/IO error.
	return (await readDir(dirnameOf(path))).find(
		(entry) => entry.name === basenameOf(path),
	);
}

export async function ensureWritingDirectory(root: string, relative: string) {
	let directory = root;
	for (const part of relative ? relative.split("/") : []) {
		directory = joinVaultPath(directory, part);
		const entry = await existing(directory);
		if (entry?.isDirectory && !entry.isSymlink) continue;
		if (entry) throw new Error(i18n.t("sidebar:writing.cloudUnsafePath"));
		await mkdir(directory);
	}
}

/** Compare immediately before projection; filesystem watch delivery is debounced. */
export async function assertWritingDiskFile(
	root: string,
	relative: string,
	expected: DiskFile | null,
) {
	const path = joinVaultPath(root, relative);
	const entry = await existing(path);
	if (!expected && !entry) return;
	if (expected?.kind === "directory" && entry?.isDirectory && !entry.isSymlink)
		return;
	if (
		expected &&
		expected.kind !== "directory" &&
		entry?.isFile &&
		!entry.isSymlink
	) {
		const current = await readFile(path);
		if (
			expected.kind === "asset" &&
			(await sha256(current)) === expected.sha256
		)
			return;
		if (expected.kind === "text") {
			try {
				if (decoder.decode(current) === expected.text) return;
			} catch {}
		}
	}
	throw new Error(i18n.t("sidebar:writing.cloudFileChanged"));
}

export async function writeProjection(
	root: string,
	relative: string,
	bytes: Uint8Array,
	expected?: DiskFile | null,
) {
	writingPath.parse(relative);
	const path = joinVaultPath(root, relative);
	const parent =
		relative.lastIndexOf("/") >= 0
			? relative.slice(0, relative.lastIndexOf("/"))
			: "";
	await ensureWritingDirectory(root, parent);
	const entry = await existing(path);
	if (entry && (!entry.isFile || entry.isSymlink))
		throw new Error(i18n.t("sidebar:writing.cloudUnsafePath"));
	const temporaryPath = joinVaultPath(
		dirnameOf(path),
		`agentero.cloud.${crypto.randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, bytes, { createNew: true });
		if (expected !== undefined)
			await assertWritingDiskFile(root, relative, expected);
		await rename(temporaryPath, path);
	} finally {
		await remove(temporaryPath).catch(() => {});
	}
}
