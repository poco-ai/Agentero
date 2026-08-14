export type { VaultFileFingerprint } from "@/lib/vault/fs";
export {
	createVaultDirectory,
	createVaultSnapshotWorkspace,
	fingerprintVaultFile,
	isMarkdownPath,
	isTextOpenable,
	readVaultBytes,
	readVaultFile,
	releaseVaultSnapshotWorkspace,
	removeVaultPath,
	splitVaultRel,
	vaultPathExists,
	writeVaultBytes,
	writeVaultFile,
	writeVaultFileAtomic,
} from "@/lib/vault/fs";
export {
	collectDefenseMaterialRelPaths,
	collectDirectoryRelPaths,
	collectMarkdownRelPaths,
	isValidVaultEntryName,
	joinVaultPath,
	normalizePathKey,
	paperRelFromNotes,
	resolveCreateParent,
	treeFindNode,
	vaultDisplayName,
	vaultRelativePath,
} from "@/lib/vault/path";
export {
	createVault,
	ensureVault,
	pickCreateVaultDirectory,
	pickVaultDirectory,
	seededSkillIdsFromCreated,
} from "@/lib/vault/pick";
export { ensureLocalFsScope } from "@/lib/vault/scope";
export {
	getRecentVaults,
	getSavedVaultPath,
	openNewWindow,
	removeRecentVault,
	saveVaultPath,
} from "@/lib/vault/session";
// openLocalVaultPath / activateVault live in actions (import from there to
// avoid circular re-exports through this barrel).
export {
	collectTreeRefreshTargets,
	collectWikiTargetRelPaths,
	isEagerTreeRel,
	isPathMissingError,
	listVaultDirChildren,
	loadVaultTree,
	pendingDirsAmongExpanded,
	removeTreeNode,
	replaceTreeNodeChildren,
	shouldIgnoreTreeName,
	treeHasPendingChildren,
} from "@/lib/vault/tree";
export type { FileNode } from "@/lib/vault/types";
