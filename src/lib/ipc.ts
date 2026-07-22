/**
 * Typed IPC layer for Tauri commands (`docs/backend/api.md` §2.2).
 *
 * Migrated commands return `Result<T, AppError>` on the Rust side: success
 * resolves with `T`, failure rejects with `{ code, message }`. `ipc()` wraps
 * `invoke` and normalizes rejections into `IpcError`.
 *
 * Legacy commands still resolve an `ApiResult` envelope; their lib wrappers
 * keep unwrapping it until each domain is migrated.
 */

import { type InvokeArgs, invoke } from "@tauri-apps/api/core";

/** Mirror of `agentero_lib::error::ErrorCode` (wire: snake_case). */
export type ErrorCode =
	| "invalid_input"
	| "vault_not_found"
	| "paper_not_found"
	| "session_not_found"
	| "agent_not_found"
	| "agent_unavailable"
	| "permission_denied"
	| "import_failed"
	| "export_failed"
	| "io"
	| "json"
	| "sqlite"
	| "acp"
	| "internal";

/** Structured command failure carrying the host error code. */
export class IpcError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "IpcError";
		this.code = code;
	}

	/** Normalize an unknown rejection (host `{code,message}`, Error, string). */
	static from(raw: unknown): IpcError {
		if (raw instanceof IpcError) return raw;
		if (typeof raw === "object" && raw !== null) {
			const rec = raw as Record<string, unknown>;
			if (typeof rec.code === "string" && typeof rec.message === "string") {
				return new IpcError(rec.code as ErrorCode, rec.message);
			}
		}
		if (raw instanceof Error) return new IpcError("internal", raw.message);
		return new IpcError("internal", String(raw));
	}
}

/** Invoke a migrated Tauri command; rejections become `IpcError`. */
export async function ipc<T>(command: string, args?: InvokeArgs): Promise<T> {
	try {
		return await invoke<T>(command, args);
	} catch (raw) {
		throw IpcError.from(raw);
	}
}
