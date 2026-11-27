/**
 * Notes-tab switcher. A paper folder can hold more than one note, but the
 * notes column shows one at a time — opening another one replaces it in place.
 * This menu lists the paper's notes so switching stays on the tab instead of a
 * detour through the file tree.
 *
 * Rendered only on paper-note tabs, and only once the paper actually has more
 * than one note, so single-note papers keep the plain tab.
 */

import { ChevronDown, FilePlus2, FileText, NotebookPen } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useVaultStore } from "@/hooks/use-app-stores";
import { basenameOf } from "@/lib/core/path";
import { createNoteInFolder } from "@/lib/vault/actions";
import { switchPaperNote } from "@/lib/workspace/actions";
import {
	isMainPaperNote,
	paperNotePaths,
	paperNotesDir,
} from "@/lib/workspace/paper-notes";
import { type DocTab, normalizeTabPath } from "@/lib/workspace/tabs";

type NoteEntry = {
	path: string;
	key: string;
	label: string;
	main: boolean;
};

/** Note name as shown in the menu: no `.md`, the main note keeps its label. */
function noteLabel(path: string, main: boolean, mainLabel: string): string {
	if (main) return mainLabel;
	return basenameOf(path).replace(/\.md$/i, "");
}

export function PaperNoteSwitcher({ tab }: { tab: DocTab }) {
	const { t } = useTranslation("app");
	const tree = useVaultStore((s) => s.tree);
	const notesPath = tab.notesPath;

	const entries = useMemo<NoteEntry[]>(() => {
		if (!notesPath) return [];
		return paperNotePaths(notesPath, tree).map((path) => {
			const main = isMainPaperNote(path);
			return {
				path,
				key: normalizeTabPath(path),
				label: noteLabel(path, main, t("tabs.noteMain")),
				main,
			};
		});
	}, [notesPath, tree, t]);

	if (!notesPath || entries.length < 2) return null;

	const current = normalizeTabPath(tab.path);
	const paperTitle =
		tab.paperMeta?.title?.trim() || basenameOf(paperNotesDir(notesPath));

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="dv-default-tab-action flex items-center justify-center"
					aria-label={t("tabs.noteSwitcher")}
					title={t("tabs.noteSwitcher")}
					// Keep dockview from starting a tab drag; the click still opens
					// the menu (this must not preventDefault).
					onPointerDown={(event) => event.stopPropagation()}
				>
					<ChevronDown className="size-3.5" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				<DropdownMenuLabel className="truncate">{paperTitle}</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={current}
					onValueChange={(key) => {
						const entry = entries.find((item) => item.key === key);
						if (entry) switchPaperNote(tab.id, entry.path);
					}}
				>
					{entries.map((entry) => (
						<DropdownMenuRadioItem key={entry.key} value={entry.key}>
							{entry.main ? (
								<NotebookPen className="size-3.5 shrink-0 text-muted-foreground" />
							) : (
								<FileText className="size-3.5 shrink-0 text-muted-foreground" />
							)}
							<span className="min-w-0 truncate">{entry.label}</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => void createNoteInFolder(paperNotesDir(notesPath))}
				>
					<FilePlus2 className="size-3.5 shrink-0" />
					{t("tabs.newNote")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
