import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchUsageBoard, type UsageBoard } from "@/lib/activity/api";
import { boardQueryRange } from "@/lib/activity/board";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

export const EMPTY_USAGE_BOARD: UsageBoard = {
	days: [],
	papers: [],
	workflows: [],
	weekPaperCount: 0,
};

function weekStartsOnFor(language: string): 0 | 1 {
	return language.toLowerCase().startsWith("zh") ? 1 : 0;
}

/** No board has been resolved for any vault yet. */
const NO_VAULT = Symbol("no-vault");

export type UsageBoardState = {
	board: UsageBoard;
	today: Date;
	weekStartsOn: 0 | 1;
	/** False until the board of the vault that is open now has arrived. */
	loaded: boolean;
};

/**
 * Six-month activity board of a vault, shared by Settings → Activity and the
 * Agent workspace home. Rows are keyed by the vault they belong to, so the
 * previous vault's numbers never show under the new vault's name.
 */
export function useUsageBoard(
	vaultPath: string | null | undefined,
): UsageBoardState {
	const { i18n } = useTranslation("settings");
	const [resolved, setResolved] = useState<{
		vault: string | null | undefined | typeof NO_VAULT;
		board: UsageBoard;
	}>({ vault: NO_VAULT, board: EMPTY_USAGE_BOARD });
	const [today] = useState(() => new Date());
	const weekStartsOn = weekStartsOnFor(i18n.language);

	useEffect(() => {
		// Usage rows are keyed by local path, so a remote vault has no board.
		if (!vaultPath || isRemoteVaultHandle(vaultPath)) {
			setResolved((prev) =>
				prev.vault === vaultPath
					? prev
					: { vault: vaultPath, board: EMPTY_USAGE_BOARD },
			);
			return;
		}
		const range = boardQueryRange(today, weekStartsOn);
		let cancelled = false;
		void fetchUsageBoard({
			vault: vaultPath,
			startDay: range.startDay,
			endDay: range.endDay,
			weekStart: range.weekStart,
		})
			.then((board) => {
				if (!cancelled) setResolved({ vault: vaultPath, board });
			})
			.catch((error) => {
				if (cancelled) return;
				notifyError(errorText(error));
				setResolved({ vault: vaultPath, board: EMPTY_USAGE_BOARD });
			});
		return () => {
			cancelled = true;
		};
	}, [today, vaultPath, weekStartsOn]);

	const current = resolved.vault === vaultPath;
	return {
		board: current ? resolved.board : EMPTY_USAGE_BOARD,
		today,
		weekStartsOn,
		loaded: current,
	};
}
