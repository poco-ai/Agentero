import {
	mkdir,
	readDir,
	remove,
	rename,
	writeTextFile,
} from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import {
	createVaultDirectory,
	readVaultFile,
	writeVaultFile,
} from "@/lib/vault/fs";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault/path";
import {
	isRemoteVaultHandle,
	parseRemoteJoinedPath,
	remoteList,
} from "@/lib/vault/remote/remote-vault";
import { ensureLocalFsScope } from "@/lib/vault/scope";

export const WRITING_MANIFEST = "agentero.project.json";
const MANIFEST_TEMPORARY = /^agentero\.project\.[0-9a-f-]{36}\.tmp$/i;
export const WRITING_COMPILERS = ["pdflatex", "xelatex", "lualatex"] as const;
export type WritingCompiler = (typeof WRITING_COMPILERS)[number];

export type WritingManifest = {
	schemaVersion: 1;
	projectId: string;
	name: string;
	mainFile: string;
	compiler: WritingCompiler;
};

export type ExplicitWritingProject = {
	directory: string;
	manifest: WritingManifest;
	root: string;
};

type Entry = {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymlink: boolean;
};

export function isWritingCompiler(value: string): value is WritingCompiler {
	return (WRITING_COMPILERS as readonly string[]).includes(value);
}

function hasControlCharacters(name: string): boolean {
	return Array.from(name).some((character) => character.charCodeAt(0) < 32);
}

export function isWritingPathSegment(name: string): boolean {
	return (
		name.length > 0 &&
		!name.startsWith(".") &&
		!/[<>:"/\\|?*]/.test(name) &&
		!hasControlCharacters(name) &&
		name.trim() === name &&
		!name.endsWith(".") &&
		name.toLowerCase() !== WRITING_MANIFEST &&
		!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
	);
}

export function parseWritingManifest(source: string): WritingManifest {
	try {
		const value: unknown = JSON.parse(source);
		if (!value || typeof value !== "object") throw new Error();
		const record = value as Record<string, unknown>;
		const { schemaVersion, projectId, name, mainFile, compiler } = record;
		if (
			schemaVersion !== 1 ||
			typeof projectId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				projectId,
			) ||
			typeof name !== "string" ||
			!name.trim() ||
			typeof mainFile !== "string" ||
			!mainFile.split("/").every(isWritingPathSegment) ||
			!mainFile.toLowerCase().endsWith(".tex") ||
			typeof compiler !== "string" ||
			!isWritingCompiler(compiler)
		)
			throw new Error();
		return {
			schemaVersion,
			projectId: projectId.toLowerCase(),
			name,
			mainFile,
			compiler,
		};
	} catch {
		throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
	}
}

async function readEntries(vault: string, directory: string): Promise<Entry[]> {
	const remote = parseRemoteJoinedPath(directory);
	if (remote) {
		const children = await remoteList(remote.sessionId, remote.rel);
		return children.map((child) => ({
			name: child.name,
			isFile: child.isFile,
			isDirectory: child.isDir,
			isSymlink: !child.isFile && !child.isDir,
		}));
	}
	await ensureLocalFsScope(vault);
	return readDir(directory);
}

async function readManifest(
	directory: string,
	entries: Entry[],
): Promise<ExplicitWritingProject | null> {
	const marker = entries.find(
		(entry) => entry.name.toLowerCase() === WRITING_MANIFEST,
	);
	if (!marker) return null;
	if (marker.name !== WRITING_MANIFEST || !marker.isFile || marker.isSymlink)
		throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
	const manifest = parseWritingManifest(
		await readVaultFile(joinVaultPath(directory, WRITING_MANIFEST)),
	);
	return {
		directory,
		manifest,
		root: joinVaultPath(directory, manifest.mainFile),
	};
}

export function writingLibraryRelative(
	vault: string,
	path: string,
): string | null {
	const rel = vaultRelativePath(vault, path);
	const parts = rel?.split("/");
	return parts?.[0] === "thesis" &&
		parts
			.slice(1)
			.every(
				(part) =>
					part && part !== "." && part !== ".." && !hasControlCharacters(part),
			)
		? rel
		: null;
}

/**
 * Read boundaries from the outside in. A malformed marker or nested project
 * is an error and cannot silently fall through to legacy project guessing.
 */
export async function explicitWritingProjectForPath(
	vault: string,
	path: string,
	directory = false,
): Promise<ExplicitWritingProject | null> {
	if (!isTauri()) return null;
	const rel = writingLibraryRelative(vault, path);
	if (!rel) return null;
	const parts = rel.split("/");
	if (!directory) parts.pop();
	let current = vault;
	let project: ExplicitWritingProject | null = null;
	let entries = await readEntries(vault, current);
	for (const [index, name] of parts.entries()) {
		const child = entries.find((entry) => entry.name === name);
		if (!child) return project;
		if (child.isSymlink || !child.isDirectory)
			throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
		current = joinVaultPath(current, name);
		entries = await readEntries(vault, current);
		if (index === 0) continue;
		const marker = await readManifest(current, entries);
		if (!marker) continue;
		if (project) throw new Error(i18n.t("sidebar:writing.nestedProject"));
		project = marker;
	}
	if (
		!directory &&
		entries.some(
			(entry) => entry.name === rel.split("/").at(-1) && entry.isSymlink,
		)
	)
		throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
	return project;
}

/** The main file may be missing while the project itself remains valid. */
export async function hasWritingMainFile(
	vault: string,
	project: ExplicitWritingProject,
): Promise<boolean> {
	const parts = project.manifest.mainFile.split("/");
	let current = project.directory;
	for (const [index, name] of parts.entries()) {
		const entries = await readEntries(vault, current);
		const child = entries.find((entry) => entry.name === name);
		if (!child) return false;
		const last = index === parts.length - 1;
		if (child.isSymlink || (last ? !child.isFile : !child.isDirectory))
			throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
		current = joinVaultPath(current, name);
	}
	return true;
}

export async function writeWritingManifest(
	directory: string,
	manifest: WritingManifest,
): Promise<void> {
	const path = joinVaultPath(directory, WRITING_MANIFEST);
	const contents = `${JSON.stringify(parseWritingManifest(JSON.stringify(manifest)), null, 2)}\n`;
	if (isRemoteVaultHandle(directory)) {
		await writeVaultFile(path, contents);
		return;
	}
	const temporary = joinVaultPath(
		directory,
		`agentero.project.${crypto.randomUUID()}.tmp`,
	);
	try {
		await writeTextFile(temporary, contents, { createNew: true });
		await rename(temporary, path);
	} finally {
		await remove(temporary).catch(() => {});
	}
}

export async function createWritingDirectory(path: string): Promise<void> {
	if (isRemoteVaultHandle(path)) await createVaultDirectory(path);
	else await mkdir(path);
}

export function isWritingManifestPath(vault: string, path: string): boolean {
	return Boolean(
		writingLibraryRelative(vault, path) &&
			basenameOf(path).toLowerCase() === WRITING_MANIFEST,
	);
}

export function isWritingProjectMetadataPath(
	vault: string,
	path: string,
): boolean {
	return (
		isWritingManifestPath(vault, path) ||
		Boolean(
			writingLibraryRelative(vault, path) &&
				MANIFEST_TEMPORARY.test(basenameOf(path)),
		)
	);
}

/** Keep the entry path attached to a renamed file or directory. */
export async function prepareWritingPathMove(
	vault: string,
	fromRel: string,
	toRel: string,
): Promise<(() => Promise<void>) | undefined> {
	const from = joinVaultPath(vault, fromRel);
	const to = joinVaultPath(vault, toRel);
	if (isWritingManifestPath(vault, from) || isWritingManifestPath(vault, to))
		throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
	const destination = await explicitWritingProjectForPath(vault, to);
	const source = await explicitWritingProjectForPath(vault, from);
	if (destination && !source && writingLibraryRelative(vault, from)) {
		const origin = await explicitWritingProjectForPath(vault, from, true).catch(
			() => null,
		);
		if (
			origin ||
			(await listExplicitWritingProjects(vault)).some((project) =>
				normalizePath(project.directory).startsWith(`${normalizePath(from)}/`),
			)
		)
			throw new Error(i18n.t("sidebar:writing.nestedProject"));
	}
	if (
		!source ||
		!(
			source.root === from ||
			normalizePath(source.root).startsWith(`${normalizePath(from)}/`)
		)
	)
		return;
	if (
		!destination ||
		normalizePath(destination.directory) !== normalizePath(source.directory)
	)
		throw new Error(i18n.t("sidebar:writing.missingMainFile"));
	const fromPath = normalizePath(from);
	const remapped = `${normalizePath(to)}${normalizePath(source.root).slice(fromPath.length)}`;
	const mainFile = vaultRelativePath(source.directory, remapped);
	if (!mainFile)
		throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
	await writeWritingManifest(source.directory, {
		...source.manifest,
		mainFile,
	});
	return () => writeWritingManifest(source.directory, source.manifest);
}

/** Visit the classification tree once, without scanning any project sources. */
export async function listExplicitWritingProjects(
	vault: string,
): Promise<ExplicitWritingProject[]> {
	if (!isTauri()) return [];
	const shelf = joinVaultPath(vault, "thesis");
	const shelfEntry = (await readEntries(vault, vault)).find(
		(entry) => entry.name === "thesis",
	);
	if (!shelfEntry) return [];
	await explicitWritingProjectForPath(vault, shelf, true);
	const projects: ExplicitWritingProject[] = [];
	const pending = [shelf];
	while (pending.length) {
		const directory = pending.pop();
		if (!directory) break;
		const entries = await readEntries(vault, directory);
		const project =
			directory === shelf ? null : await readManifest(directory, entries);
		if (project) {
			projects.push(project);
			continue;
		}
		for (const entry of entries) {
			if (
				entry.isDirectory &&
				!entry.isSymlink &&
				isWritingPathSegment(entry.name)
			)
				pending.push(joinVaultPath(directory, entry.name));
		}
	}
	return projects;
}

/** A copied or nested manifest must be resolved before attaching cloud state. */
export async function validateWritingProjectForSharing(
	vault: string,
	directory: string,
): Promise<ExplicitWritingProject> {
	const project = await explicitWritingProjectForPath(vault, directory, true);
	if (!project || !sameWritingDirectory(project.directory, directory))
		throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
	const matches = (await listExplicitWritingProjects(vault)).filter(
		(item) => item.manifest.projectId === project.manifest.projectId,
	);
	if (matches.length !== 1)
		throw new Error(i18n.t("sidebar:writing.duplicateProjectId"));
	const pending = [directory];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		const entries = await readEntries(vault, current);
		if (
			current !== directory &&
			entries.some((entry) => entry.name.toLowerCase() === WRITING_MANIFEST)
		)
			throw new Error(i18n.t("sidebar:writing.nestedProject"));
		for (const entry of entries) {
			if (entry.isDirectory && !entry.isSymlink && entry.name !== ".git")
				pending.push(joinVaultPath(current, entry.name));
		}
	}
	return project;
}

/** Enumerate ordinary files without following links or crossing project roots. */
export async function listWritingProjectFiles(
	vault: string,
	project: ExplicitWritingProject,
): Promise<string[]> {
	const files: string[] = [];
	const pending = [{ directory: project.directory, prefix: "" }];
	while (pending.length) {
		const next = pending.pop();
		if (!next) break;
		for (const entry of await readEntries(vault, next.directory)) {
			if (entry.name.toLowerCase() === WRITING_MANIFEST) {
				if (next.prefix)
					throw new Error(i18n.t("sidebar:writing.nestedProject"));
				continue;
			}
			if (MANIFEST_TEMPORARY.test(entry.name)) continue;
			if (entry.name.startsWith(".") && entry.name !== ".latexmkrc") continue;
			if (entry.isSymlink)
				throw new Error(i18n.t("sidebar:writing.invalidProjectConfig"));
			const relative = next.prefix + entry.name;
			if (entry.isDirectory) {
				pending.push({
					directory: joinVaultPath(project.directory, relative),
					prefix: `${relative}/`,
				});
			} else if (entry.isFile) {
				files.push(relative);
			}
		}
	}
	return files;
}

export function sameWritingDirectory(a: string, b: string): boolean {
	return normalizePath(a) === normalizePath(b);
}
