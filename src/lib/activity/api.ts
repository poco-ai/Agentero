import { commands, type UsageRecord } from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import { broadcastSafe, toSafeDisposer } from "@/lib/core/tauri-events";

const USAGE_CLEARED_EVENT = "activity:usage-cleared";

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

export async function clearUsage(vault?: string): Promise<number> {
	if (!isTauri()) return 0;
	const cleared = await callApi(
		() => commands.usageClear({ vault: vault ?? null }),
		{ fallback: "usage_clear failed" },
	);
	broadcastSafe(USAGE_CLEARED_EVENT, { vault: vault ?? null });
	return cleared;
}

/** Native Settings and Library can live in different windows. */
export function subscribeUsageCleared(
	listener: (vault: string | null) => void,
): () => void {
	if (!isTauri()) return () => undefined;
	return toSafeDisposer(
		import("@tauri-apps/api/event").then(({ listen }) =>
			listen<{ vault: string | null }>(USAGE_CLEARED_EVENT, (event) => {
				listener(event.payload.vault);
			}),
		),
	);
}

/** Persisted effective reading totals; daily rollups outlive raw activity events. */
export async function loadReadingDurations(
	vault: string,
): Promise<Record<string, number>> {
	if (!isTauri() || !vault) return {};
	return callApi(() => commands.usageReadingDurations({ vault }), {
		fallback: "usage_reading_durations failed",
	});
}
