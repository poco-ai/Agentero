import { logger } from "@/lib/core/logger";

/**
 * Local-first funnel markers for the viva. One structured log line per event,
 * greppable as `[viva]` — nothing leaves the machine. Enough to answer
 * "where do sessions die?" from a user's log file.
 */
export type VivaMetricEvent =
	| "dialog_opened"
	| "preparation_started"
	| "preparation_completed"
	| "preparation_failed"
	| "session_connected"
	| "session_ended"
	| "transcript_saved";

export function trackViva(
	event: VivaMetricEvent,
	data?: Record<string, string | number | boolean | null | undefined>,
): void {
	const fields = Object.entries(data ?? {})
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" ");
	logger.info(`[viva] ${event}${fields ? ` ${fields}` : ""}`);
}
