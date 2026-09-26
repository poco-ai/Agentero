import { EditablePaperTag } from "@/components/library/editable-paper-tag";
import type { PaperLibraryRow } from "@/lib/paper";
import { libraryStore, setLibraryPaperTags } from "@/lib/paper/library-store";
import { type PaperTag, withPaperTagColor } from "@/lib/paper/tags";
import { getVaultPath } from "@/lib/vault/store";

export function LibraryPaperTag({
	paper,
	tag,
}: {
	paper: PaperLibraryRow;
	tag: PaperTag;
}) {
	const vaultPath = getVaultPath();
	return (
		<EditablePaperTag
			tag={tag}
			disabled={!vaultPath || !paper.path}
			onColorChange={async (color) => {
				if (!vaultPath || !paper.path || getVaultPath() !== vaultPath) return;
				const current = libraryStore
					.getState()
					.papers.find((row) => row.path === paper.path);
				if (!current) return;
				await setLibraryPaperTags(
					vaultPath,
					paper.path,
					withPaperTagColor(current.tags, tag.name, color),
				);
			}}
		/>
	);
}
