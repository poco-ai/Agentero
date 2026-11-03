/** Shared project utilities, independent of the currently selected document. */
import { useTranslation } from "react-i18next";
import { SiGithub } from "react-icons/si";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useVaultStore, useWritingStore } from "@/hooks/use-app-stores";
import { closeWritingHistory, closeWritingSync } from "@/lib/writing/store";
import { WritingHistory } from "./writing-history";
import { WritingSyncTab } from "./writing-sync-tab";

export function WritingDialogs() {
	const { t } = useTranslation("sidebar");
	const vault = useVaultStore((s) => s.vaultPath);
	const history = useWritingStore((s) => s.historyActive);
	const sync = useWritingStore((s) => s.syncActive);
	return (
		<>
			<Dialog
				open={history}
				onOpenChange={(open) => {
					if (!open) closeWritingHistory();
				}}
			>
				<DialogContent
					className="flex h-[75vh] sm:max-w-5xl flex-col overflow-hidden"
					aria-describedby={undefined}
				>
					<DialogTitle>{t("writing.history")}</DialogTitle>
					<div className="min-h-0 flex-1">
						<WritingHistory />
					</div>
				</DialogContent>
			</Dialog>
			<Dialog
				open={sync}
				onOpenChange={(open) => {
					if (!open) closeWritingSync();
				}}
			>
				<DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<SiGithub
								className="size-4 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							{t("writing.syncSetup")}
						</DialogTitle>
						<DialogDescription>{t("writing.syncSetupHint")}</DialogDescription>
					</DialogHeader>
					{vault ? (
						<WritingSyncTab vaultPath={vault} showHeader={false} />
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
