export type VoiceSessionActivity = "connecting" | "speaking" | "caption";

/**
 * Resolve the immutable start timestamp for one voice session.
 *
 * The caller supplies `now` so the transition stays deterministic in tests.
 */
export function nextVoiceSessionStartedAt(
	current: Date | null,
	activity: VoiceSessionActivity,
	now: Date,
): Date | null {
	if (current) return current;
	return activity === "speaking" || activity === "caption" ? now : null;
}
