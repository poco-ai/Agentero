/** Discover declared projects and retain first-level legacy local projects. */

import { basenameOf, normalizePath } from "@/lib/core/path";
import {
	type FileNode,
	joinVaultPath,
	listVaultDirChildren,
	readVaultFile,
} from "@/lib/vault";
import { isWritingSourceName } from "@/lib/writing/files";
import {
	type Manuscript,
	manuscriptFromRoot,
	writingProjectTitle,
} from "@/lib/writing/session";
import {
	listExplicitWritingProjects,
	WRITING_MANIFEST,
} from "./project-manifest";

const FILES_PER_DIR = 64;
const DIRS_PER_LEVEL = 16;

function isTexFile(path: string): boolean {
	return /\.tex$/i.test(path);
}

/** `main.tex` first, then a file named like the folder, then by path. */
function preferredRoot(dir: string, files: readonly string[]): string {
	const folder = basenameOf(dir).toLowerCase();
	const score = (path: string) => {
		const stem = basenameOf(path)
			.replace(/\.tex$/i, "")
			.toLowerCase();
		if (stem === "main") return 0;
		if (stem === "thesis") return 1;
		if (stem === folder) return 2;
		return 3;
	};
	return (
		[...files].sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0] ??
		""
	);
}

/** Root file of one project folder; chapters may live in immediate subfolders. */
export async function findTexRoot(
	vaultPath: string,
	dir: string,
	depth: number,
): Promise<string | null> {
	let children: FileNode[];
	try {
		children = await listVaultDirChildren(vaultPath, dir);
	} catch {
		return null;
	}
	if (children.some((node) => node.name.toLowerCase() === WRITING_MANIFEST))
		return null;
	const texFiles = children
		.filter((node) => node.kind === "file" && isTexFile(node.path))
		.slice(0, FILES_PER_DIR)
		.map((node) => node.path);
	if (texFiles.length > 0) return preferredRoot(dir, texFiles);
	if (depth <= 0) return null;
	const directories = children
		.filter(
			(node) =>
				node.kind === "directory" &&
				isWritingSourceName("directory", node.name),
		)
		.slice(0, DIRS_PER_LEVEL);
	for (const directory of directories) {
		const root = await findTexRoot(vaultPath, directory.path, depth - 1);
		if (root) return root;
	}
	return null;
}

async function projectFromRoot(rootFile: string): Promise<Manuscript> {
	let head = "";
	try {
		head = (await readVaultFile(rootFile)).slice(0, 8000);
	} catch {
		head = "";
	}
	const base = manuscriptFromRoot(rootFile);
	return { ...base, title: writingProjectTitle(rootFile, head) };
}

/** Projects at any classification depth, in title order. */
export async function discoverWritingProjects(
	vaultPath: string,
): Promise<Manuscript[]> {
	let children: FileNode[];
	try {
		children = await listVaultDirChildren(
			vaultPath,
			joinVaultPath(vaultPath, "thesis"),
		);
	} catch {
		return [];
	}
	const directories = children.filter(
		(node) =>
			node.kind === "directory" && isWritingSourceName("directory", node.name),
	);
	const declared = await listExplicitWritingProjects(vaultPath);
	const projects = await Promise.all(
		directories
			.filter(
				(directory) =>
					!declared.some(
						(project) =>
							normalizePath(project.directory) ===
								normalizePath(directory.path) ||
							normalizePath(project.directory).startsWith(
								`${normalizePath(directory.path)}/`,
							),
					),
			)
			.map(async (directory) => {
				const root = await findTexRoot(vaultPath, directory.path, 1);
				return root ? projectFromRoot(root) : null;
			}),
	);
	const manuscripts: Manuscript[] = [
		...declared.map((project) => ({
			...manuscriptFromRoot(project.root),
			title: project.manifest.name,
		})),
		...projects.filter((project): project is Manuscript => project !== null),
	];
	manuscripts.sort((a, b) => {
		if (!a.title && b.title) return 1;
		if (a.title && !b.title) return -1;
		return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
	});
	return manuscripts;
}
