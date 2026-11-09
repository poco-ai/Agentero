/**
 * Global user-facing notifications (top-right toasts via Sonner).
 *
 * Use for operational failures across vault / lookup / tree / library.
 * Keep form-field validation (inline under the input) local to the form.
 */

import { toast } from "sonner";
import { BACKGROUND_TASK_CANCELLED_MESSAGE } from "@/lib/core/background-tasks";

export type NotifyOptions = {
	/** Optional secondary line under the title. */
	description?: string;
	/** Stable id collapses duplicates (same id replaces the previous toast). */
	id?: string | number;
	/** Auto-dismiss ms; default 7s for errors. */
	duration?: number;
	/** Optional inline action (e.g. "Open settings" on a config error). */
	action?: { label: string; onClick: () => void };
};

/** Show an error toast in the top-right stack. */
export function notifyError(
	message: string,
	opts: NotifyOptions = {},
): string | number {
	const text = message?.trim();
	if (!text) return "";
	// User-initiated cancel is not an error — do not toast.
	if (text === BACKGROUND_TASK_CANCELLED_MESSAGE) return "";
	reportNetworkFailureIfLikely(text, opts.description);
	return toast.error(text, {
		description: opts.description,
		id: opts.id,
		// Keep the action reachable much longer than a plain error toast, so the
		// user has time to click through to the settings fix.
		duration: opts.duration ?? (opts.action ? 20_000 : 7000),
		action: opts.action,
	});
}

/** Warning / soft failure (e.g. import partial success with warnings). */
export function notifyWarning(
	message: string,
	opts: NotifyOptions = {},
): string | number {
	const text = message?.trim();
	if (!text) return "";
	reportNetworkFailureIfLikely(text, opts.description);
	return toast.warning(text, {
		description: opts.description,
		id: opts.id,
		duration: opts.duration ?? (opts.action ? 20_000 : 6000),
		action: opts.action,
	});
}

/** Brief success feedback (optional; keep rare per UI simplicity rules). */
export function notifySuccess(
	message: string,
	opts: NotifyOptions = {},
): string | number {
	const text = message?.trim();
	if (!text) return "";
	return toast.success(text, {
		description: opts.description,
		id: opts.id,
		duration: opts.duration ?? 3500,
	});
}

export type UndoOptions = {
	actionLabel: string;
	onAction: () => void;
	/** Auto-dismiss ms; default 8s so the action stays reachable. */
	duration?: number;
};

/** Neutral toast with an inline action (e.g. "Deleted N · Undo"). */
export function notifyUndo(
	message: string,
	{ actionLabel, onAction, duration }: UndoOptions,
): string | number {
	const text = message?.trim();
	if (!text) return "";
	return toast(text, {
		duration: duration ?? 8000,
		action: { label: actionLabel, onClick: onAction },
	});
}

export type ActionOptions = NotifyOptions & {
	actionLabel: string;
	onAction: () => void;
};

/** Neutral notice with an explicit action, for non-destructive workflows. */
export function notifyAction(
	message: string,
	{ actionLabel, onAction, description, id, duration }: ActionOptions,
): string | number {
	const text = message?.trim();
	if (!text) return "";
	return toast(text, {
		description,
		id,
		duration: duration ?? 12_000,
		action: { label: actionLabel, onClick: onAction },
	});
}

export type ReminderOptions = {
	description?: string;
	/** Stable id collapses duplicates (same id replaces the previous toast). */
	id?: string | number;
	/** Auto-dismiss ms; default 20s so both buttons stay reachable. */
	duration?: number;
	/** Primary action (e.g. "Open settings"). */
	actionLabel: string;
	onAction: () => void;
	/** Optional secondary action (e.g. "Don't remind again"). Omit for a
	 * single-action reminder; the toast can still be dismissed. */
	dismissLabel?: string;
	onDismiss?: () => void;
};

/**
 * Periodic config reminder with up to two choices: jump to the fix, and
 * optionally stop showing it. Uses Sonner's secondary `cancel` button so
 * "don't remind again" does not read as the primary call to action. Callers
 * that already surface a persistent in-place control (the Markdown conflict
 * banner) omit the secondary label: a dismiss that does nothing is worse than
 * no dismiss at all.
 */
export function notifyReminder(
	message: string,
	{
		description,
		id,
		duration,
		actionLabel,
		onAction,
		dismissLabel,
		onDismiss,
	}: ReminderOptions,
): string | number {
	const text = message?.trim();
	if (!text) return "";
	// Both halves are optional so a caller with an in-place control can drop the
	// no-op secondary action; pass the pair only when both are present.
	const cancel =
		dismissLabel && onDismiss
			? { label: dismissLabel, onClick: onDismiss }
			: undefined;
	return toast(text, {
		description,
		id,
		duration: duration ?? 20_000,
		action: { label: actionLabel, onClick: onAction },
		cancel,
		// Stack the actions below the text instead of Sonner's default inline row
		// (see `cn-reminder-toast` in index.css).
		classNames: { toast: "cn-reminder-toast" },
	});
}

/**
 * Network-ish failure text (Host errors are English; UI messages pass through).
 * Kept narrow so the proxy reminder only fires on real connectivity failures.
 */
const NETWORK_FAILURE_RE =
	/timed?\s*out|timeout|dns|name resolution|resolve host|connection (refused|reset|closed|aborted)|connect(ion)? (error|failed)|network (is )?unreachable|failed to (connect|fetch|resolve)|unreachable|\btls\b|handshake|certificate|\bproxy\b/i;

export function isLikelyNetworkFailure(message: string): boolean {
	return NETWORK_FAILURE_RE.test(message);
}

/**
 * Registered by the main window (`useConfigReminders`) to surface the proxy
 * reminder. Kept as a setter so this funnel stays a leaf: the reminder module
 * imports this file, and importing it back would create a cycle.
 */
let networkFailureReporter: (() => void) | null = null;

export function setNetworkFailureReporter(fn: (() => void) | null): void {
	networkFailureReporter = fn;
}

function reportNetworkFailureIfLikely(
	message: string,
	description?: string,
): void {
	if (!isLikelyNetworkFailure(`${message} ${description ?? ""}`)) return;
	// Registered by the main window (see `use-config-reminders`).
	networkFailureReporter?.();
}

/** Coerce unknown catch values into a display string. */
export function errorMessage(err: unknown, fallback = "Error"): string {
	if (err instanceof Error && err.message.trim()) return err.message;
	if (typeof err === "string" && err.trim()) return err;
	if (err != null && String(err).trim()) return String(err);
	return fallback;
}
