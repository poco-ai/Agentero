import {
	commands,
	type UsageBoard,
	type UsageDayStat,
	type UsageRecord,
} from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

export type { UsageBoard, UsageDayStat };

/** Wire shapes from the generated bindings (usage.sqlite rows). */
export type ActivityRecord = UsageRecord;

export async function recordActivityEvents(
	events: ActivityRecord[],
): Promise<number> {
	if (!isTauri() || events.length === 0) return 0;
	return callApiResult(() => commands.activityRecordEvents({ events }), {
		fallback: "activity_record_events failed",
	});
}

export async function fetchUsageBoard(args: {
	vault: string;
	startDay: string;
	endDay: string;
	weekStart: string;
}): Promise<UsageBoard> {
	if (!isTauri()) {
		return { days: [], papers: [], workflows: [], weekPaperCount: 0 };
	}
	return callApi(() => commands.usageBoardQuery(args), {
		fallback: "usage_board failed",
	});
}

export async function clearUsage(vault?: string): Promise<number> {
	if (!isTauri()) return 0;
	return callApi(() => commands.usageClear({ vault: vault ?? null }), {
		fallback: "usage_clear failed",
	});
}
