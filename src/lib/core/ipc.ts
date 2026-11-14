/**
 * Typed Tauri command helpers over the generated specta bindings
 * (`src/lib/core/bindings.ts`).
 *
 * Two Host envelope shapes exist (docs/backend/api.md §2.6):
 * 1. `ApiResult<T>` — the promise never rejects on host errors; `ok` selects
 *    `data` vs `error` ({@link callApi}).
 * 2. `Result<ApiResult<T>, String>` — specta wraps the IPC-level string error
 *    into `{ status: "error", error }`; check `status` first, then `ok`
 *    ({@link callApiResult}). Commands typed `Result<T, String>` without an
 *    inner envelope use {@link callResult}.
 *
 * All helpers keep the legacy throw semantics: host failures surface as
 * `Error` (message from the Host `ErrorBody`, fallback when absent) with the
 * structured `details` payload attached, so existing try/catch + `notifyError`
 * call sites behave unchanged.
 */

import type { ApiResult } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";

export type ApiError = Error & { code?: string; details?: unknown };

/** IPC-level envelope produced by specta's `typedError` wrapper. */
export type TypedResult<T> =
	| { status: "ok"; data: T }
	| { status: "error"; error: string };

export type CallApiOptions = {
	/** Error message when the Host error carries no message. */
	fallback?: string;
	/** When set, non-Tauri environments throw this message. */
	desktopOnly?: string;
};

/**
 * Runtime error body. The generated `ErrorBody` type omits `details`
 * (`#[specta(skip)]`), but the field is still serialized; wiki rename
 * recovery reads it, so keep it here.
 */
type RuntimeErrorBody = {
	code: string;
	message: string;
	details?: unknown;
};

function ensureDesktop(opts: CallApiOptions): void {
	if (isTauri()) return;
	throw new Error(
		opts.desktopOnly ??
			opts.fallback ??
			"This action requires the Tauri desktop app.",
	);
}

function hostError(error: unknown, fallback?: string): ApiError {
	const body = error as RuntimeErrorBody | null;
	const thrown = new Error(
		body?.message || fallback || "Host command failed",
	) as ApiError;
	if (typeof body?.code === "string" && body.code) thrown.code = body.code;
	thrown.details = body?.details;
	return thrown;
}

function ipcError(message: string, fallback?: string): ApiError {
	return new Error(message || fallback || "Host command failed") as ApiError;
}

/** Envelope 1: unwrap `ApiResult<T>`; throws with the host error when `!ok`. */
export async function callApi<T>(
	fn: () => Promise<ApiResult<T>>,
	opts: CallApiOptions = {},
): Promise<T> {
	ensureDesktop(opts);
	const res = await fn();
	if (!res.ok) throw hostError(res.error, opts.fallback);
	return res.data as T;
}

/**
 * Envelope 2: unwrap `Result<ApiResult<T>, String>` — throws on the IPC-level
 * string error, then on the inner host error.
 */
export async function callApiResult<T>(
	fn: () => Promise<TypedResult<ApiResult<T>>>,
	opts: CallApiOptions = {},
): Promise<T> {
	ensureDesktop(opts);
	const res = await fn();
	if (res.status === "error") throw ipcError(res.error, opts.fallback);
	if (!res.data.ok) throw hostError(res.data.error, opts.fallback);
	return res.data.data as T;
}

/**
 * Envelope 2 with a plain payload: unwrap `Result<T, String>` (window/shell
 * commands with no inner `ApiResult`).
 */
export async function callResult<T>(
	fn: () => Promise<TypedResult<T>>,
	opts: CallApiOptions = {},
): Promise<T> {
	ensureDesktop(opts);
	const res = await fn();
	if (res.status === "error") throw ipcError(res.error, opts.fallback);
	return res.data;
}
