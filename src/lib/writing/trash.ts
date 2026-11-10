/**
 * Move a writing project into the vault recycle bin. The shelf directory
 * `thesis/` is not a project and cannot be removed from here.
 */

import { normalizePath } from "@/lib/core/path";
import { trashPathsAndNotify } from "@/lib/vault/actions";
import { vaultPathExists } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";
import { discoverWritingProjects } from "@/lib/writing/discover";
import { writingProjectTrashRel } from "@/lib/writing/session";
import {
	forgetWritingProject,
	setDiscoveredManuscripts,
	setWritingDiscovering,
} from "@/lib/writing/store";
import { explicitWritingProjectForPath } from "./project-manifest";

export async function trashWritingProject(
	vaultPath: string,
	rootFile: string,
): Promise<boolean> {
	const rel = writingProjectTrashRel(vaultPath, rootFile);
	if (!rel) return false;
	const project = await explicitWritingProjectForPath(vaultPath, rootFile);
	const target = project?.directory ?? joinVaultPath(vaultPath, rel);
	const fileOnly = normalizePath(target) === normalizePath(rootFile);
	await trashPathsAndNotify([target]);
	if (await vaultPathExists(target)) return false;
	forgetWritingProject(rootFile, fileOnly ? "file" : "directory");
	try {
		setWritingDiscovering(true);
		setDiscoveredManuscripts(await discoverWritingProjects(vaultPath));
	} catch {
		setWritingDiscovering(false);
	}
	return true;
}
