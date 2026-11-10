/**
 * Create one compilable TeX project under the vault's thesis/ shelf.
 * The folder name is the project; thesis/ itself is not a project.
 */

import { errorText } from "@/lib/core/error";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { inferRequiredEngine, parseTexProgram } from "@/lib/tex/engine";
import {
	createVaultDirectory,
	joinVaultPath,
	readVaultBytes,
	removeVaultPath,
	vaultPathExists,
	vaultRelativePath,
	writeVaultBytes,
	writeVaultFile,
} from "@/lib/vault";
import { refreshTree } from "@/lib/vault/store";
import { resolveTexPdfPath } from "@/lib/workspace/tex-compile";
import { isWritingSourceName } from "@/lib/writing/files";
import {
	createWritingDirectory,
	type ExplicitWritingProject,
	explicitWritingProjectForPath,
	isWritingCompiler,
	isWritingPathSegment,
	listWritingProjectFiles,
	sameWritingDirectory,
	type WritingCompiler,
	type WritingManifest,
	writeWritingManifest,
	writingLibraryRelative,
} from "@/lib/writing/project-manifest";
import {
	type WritingTemplateId,
	writingTemplateAssets,
	writingTemplateFiles,
	writingTemplateRoot,
} from "@/lib/writing/templates";

export type CreateWritingProjectResult =
	| { ok: true; rootFile: string; project: WritingManifest }
	| { ok: false; reason: "invalid" | "exists" | "failed"; message?: string };

export async function createWritingProject(
	vaultPath: string,
	name: string,
	template: WritingTemplateId = "blank",
	parent = joinVaultPath(vaultPath, "thesis"),
	compiler?: WritingCompiler,
): Promise<CreateWritingProjectResult> {
	const trimmed = name.trim();
	const collection = writingLibraryRelative(vaultPath, parent);
	if (!isWritingPathSegment(trimmed) || !collection)
		return { ok: false, reason: "invalid" };
	const dir = joinVaultPath(parent, trimmed);
	const mainFile = writingTemplateRoot(template);
	const rootFile = joinVaultPath(dir, mainFile);
	const starter = writingTemplateFiles(template, trimmed);
	const source = starter.find((file) => file.name === mainFile)?.contents ?? "";
	const inferred =
		parseTexProgram(source) ?? inferRequiredEngine(source) ?? "xelatex";
	const project: WritingManifest = {
		schemaVersion: 1,
		projectId: crypto.randomUUID(),
		name: trimmed,
		mainFile,
		compiler: compiler ?? (isWritingCompiler(inferred) ? inferred : "xelatex"),
	};
	let created = false;
	try {
		if (await explicitWritingProjectForPath(vaultPath, parent, true))
			return { ok: false, reason: "invalid" };
		if (collection === "thesis" && !(await vaultPathExists(parent)))
			await createVaultDirectory(parent);
		if (await vaultPathExists(dir)) return { ok: false, reason: "exists" };
		await createWritingDirectory(dir);
		created = true;
		for (const file of starter) {
			await writeVaultFile(joinVaultPath(dir, file.name), file.contents);
		}
		for (const asset of writingTemplateAssets(template)) {
			const response = await fetch(asset.url);
			if (!response.ok) throw new Error(asset.name);
			await writeVaultBytes(
				joinVaultPath(dir, asset.name),
				new Uint8Array(await response.arrayBuffer()),
			);
		}
		await writeWritingManifest(dir, project);
	} catch (error) {
		if (created) await removeVaultPath(dir).catch(() => {});
		return { ok: false, reason: "failed", message: errorText(error) };
	}
	await refreshTree(vaultPath);
	return { ok: true, rootFile, project };
}

export async function copyWritingProject(
	vault: string,
	source: ExplicitWritingProject,
	name: string,
): Promise<CreateWritingProjectResult> {
	const trimmed = name.trim();
	const sourceRelative = vaultRelativePath(vault, source.directory);
	if (!sourceRelative || !isWritingPathSegment(trimmed))
		return { ok: false, reason: "invalid" };
	const parent = joinVaultPath(
		vault,
		sourceRelative.slice(0, sourceRelative.lastIndexOf("/")),
	);
	const directory = joinVaultPath(parent, trimmed);
	let created = false;
	try {
		const current = await explicitWritingProjectForPath(
			vault,
			source.directory,
			true,
		);
		if (
			!current ||
			!sameWritingDirectory(current.directory, source.directory) ||
			current.manifest.projectId !== source.manifest.projectId
		)
			return { ok: false, reason: "invalid" };
		if (await vaultPathExists(directory))
			return { ok: false, reason: "exists" };
		const files = await listWritingProjectFiles(vault, current);
		const output = normalizePath(await resolveTexPdfPath(current.root));
		await createWritingDirectory(directory);
		created = true;
		for (const relative of files) {
			const path = joinVaultPath(current.directory, relative);
			const name = basenameOf(relative);
			if (
				normalizePath(path) === output ||
				(!isWritingSourceName("file", name) &&
					!name.toLowerCase().endsWith(".pdf"))
			)
				continue;
			await writeVaultBytes(
				joinVaultPath(directory, relative),
				await readVaultBytes(path),
			);
		}
		const project: WritingManifest = {
			...current.manifest,
			name: trimmed,
			projectId: crypto.randomUUID(),
		};
		await writeWritingManifest(directory, project);
		await refreshTree(vault);
		return {
			ok: true,
			project,
			rootFile: joinVaultPath(directory, project.mainFile),
		};
	} catch (error) {
		if (created) await removeVaultPath(directory).catch(() => {});
		return { ok: false, reason: "failed", message: errorText(error) };
	}
}
