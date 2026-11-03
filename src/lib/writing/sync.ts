/**
 * Explicit git sync for one writing project. Each project under `thesis/` has
 * its own repository. Autosave does not call this.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ApiResult } from "@/lib/core/bindings";

export type WritingSyncReport = {
	committed: boolean;
	pushed: boolean;
	remote: boolean;
	code: string;
	detail: string;
};

export async function syncWritingProject(
	projectDir: string,
	remote: string,
	branch: string,
): Promise<WritingSyncReport> {
	const result = await invoke<ApiResult<WritingSyncReport>>(
		"writing_sync_project",
		{ projectDir, remote, branch },
	);
	if (!result.ok || result.data == null) {
		throw new Error(result.error?.message ?? "writing_sync_project");
	}
	return result.data;
}

export type WritingGitFile = {
	path: string;
	added: number;
	removed: number;
};

export type WritingGitCommit = {
	id: string;
	at: number;
	summary: string;
	files: WritingGitFile[];
};

export type WritingGitLog = {
	code: string;
	commits: WritingGitCommit[];
};

export type WritingGitDiff = {
	code: string;
	patch: string;
	truncated: boolean;
};

export async function loadWritingGitLog(
	projectDir: string,
): Promise<WritingGitLog> {
	const result = await invoke<ApiResult<WritingGitLog>>("writing_git_log", {
		projectDir,
	});
	if (!result.ok || result.data == null) {
		throw new Error(result.error?.message ?? "writing_git_log");
	}
	return result.data;
}

export async function loadWritingGitDiff(
	projectDir: string,
	commit: string,
): Promise<WritingGitDiff> {
	const result = await invoke<ApiResult<WritingGitDiff>>("writing_git_diff", {
		projectDir,
		commit,
	});
	if (!result.ok || result.data == null) {
		throw new Error(result.error?.message ?? "writing_git_diff");
	}
	return result.data;
}

export async function restoreWritingRevision(
	projectDir: string,
	commit: string,
): Promise<WritingSyncReport> {
	const result = await invoke<ApiResult<WritingSyncReport>>(
		"writing_git_restore",
		{ projectDir, commit },
	);
	if (!result.ok || result.data == null) {
		throw new Error(result.error?.message ?? "writing_git_restore");
	}
	return result.data;
}
