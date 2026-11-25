/**
 * App-level dialogs: Zotero migration, rename, external-rename repair, and
 * move papers. Each subscribes to its own store slice. Quick open lives in
 * the title bar (`quick-open.tsx`).
 */

import { AlphaXivImportDialog } from "@/components/dialogs/alphaxiv-import-dialog";
import { ExternalRenameDialog } from "@/components/dialogs/external-rename-dialog";
import { PaperSearchDialog } from "@/components/dialogs/paper-search-dialog";
import { SkillImportDialog } from "@/components/dialogs/skill-import-dialog";
import { WordCitationDialog } from "@/components/dialogs/word-citation-dialog";
import { ZoteroMigrateDialog } from "@/components/dialogs/zotero-migrate-dialog";
import { ZoteroSyncDialog } from "@/components/dialogs/zotero-sync-dialog";
import { CitingScanDialog } from "@/components/library/citing-scan-dialog";
import { EditPaperMetaDialog } from "@/components/library/edit-paper-meta-dialog";
import "@/components/shell/palette-commands";
import {
	useLibraryStore,
	useUiStore,
	useVaultStore,
} from "@/hooks/use-app-stores";
import {
	cancelCitingImport,
	cancelPaperSearchImport,
	cancelSkillImport,
	confirmCitingImport,
	confirmPaperSearchImport,
	confirmSkillImport,
} from "@/lib/paper/import-actions";
import { paperMetaChange } from "@/lib/paper/library-actions";
import { setEditMetaDraft } from "@/lib/paper/library-store";
import {
	setAlphaXivOpen,
	setZoteroOpen,
	setZoteroSyncOpen,
} from "@/lib/shell/ui-store";
import { refreshAll } from "@/lib/vault/actions";

export function AppDialogs() {
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const zoteroOpen = useUiStore((s) => s.zoteroOpen);
	const zoteroParentDir = useUiStore((s) => s.zoteroParentDir);
	const alphaxivOpen = useUiStore((s) => s.alphaxivOpen);
	const alphaxivParentDir = useUiStore((s) => s.alphaxivParentDir);
	const zoteroSyncOpen = useUiStore((s) => s.zoteroSyncOpen);
	const editMetaDraft = useLibraryStore((s) => s.editMetaDraft);
	const citingScanDraft = useLibraryStore((s) => s.citingScanDraft);
	const skillImportDraft = useUiStore((s) => s.skillImportDraft);
	const paperSearchDraft = useUiStore((s) => s.paperSearchDraft);

	return (
		<>
			<WordCitationDialog />
			<ZoteroMigrateDialog
				open={zoteroOpen}
				onOpenChange={setZoteroOpen}
				vaultPath={vaultPath}
				initialParentDir={zoteroParentDir}
				onDone={refreshAll}
			/>
			<AlphaXivImportDialog
				open={alphaxivOpen}
				onOpenChange={setAlphaXivOpen}
				vaultPath={vaultPath}
				parentDir={alphaxivParentDir}
				onDone={refreshAll}
			/>
			<ZoteroSyncDialog
				open={zoteroSyncOpen}
				onOpenChange={setZoteroSyncOpen}
				vaultPath={vaultPath}
				onDone={refreshAll}
			/>
			<SkillImportDialog
				discoveries={skillImportDraft}
				onCancel={cancelSkillImport}
				onConfirm={confirmSkillImport}
			/>
			<PaperSearchDialog
				groups={paperSearchDraft}
				onCancel={cancelPaperSearchImport}
				onConfirm={confirmPaperSearchImport}
			/>
			<CitingScanDialog
				result={citingScanDraft}
				onCancel={cancelCitingImport}
				onConfirm={confirmCitingImport}
			/>

			<ExternalRenameDialog />

			<EditPaperMetaDialog
				paper={editMetaDraft}
				onOpenChange={(open) => {
					if (!open) setEditMetaDraft(null);
				}}
				onConfirm={async (paper, patch) => {
					const updated = await paperMetaChange(paper, patch);
					if (updated) setEditMetaDraft(null);
				}}
			/>
		</>
	);
}
