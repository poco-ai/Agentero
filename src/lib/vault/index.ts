export {
	createVaultDirectory,
	createVaultFile,
	isMarkdownPath,
	isTextOpenable,
	readVaultBytes,
	readVaultFile,
	removeVaultPath,
	splitVaultRel,
	vaultPathExists,
	writeVaultBytes,
	writeVaultFile,
} from "@/lib/vault/fs";
export type { VaultRenamePlan } from "@/lib/vault/path";
export {
	collectDirectoryRelPaths,
	collectMarkdownRelPaths,
	hasVaultFileExtension,
	isPapersParent,
	isValidVaultEntryName,
	joinVaultPath,
	normalizePathKey,
	paperRelFromNotes,
	planVaultRename,
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
	compareVaultTreeNodes,
	directoryIsLoaded,
	isEagerTreeRel,
	isPathMissingError,
	listVaultDirChildren,
	loadVaultTree,
	pendingDirsAmongExpanded,
	removeTreeNode,
	replaceTreeNodeChildren,
	shouldIgnoreTreeName,
	treeHasPendingChildren,
	upsertTreeChild,
} from "@/lib/vault/tree";
export type { FileNode } from "@/lib/vault/types";
