import { listen } from "@tauri-apps/api/event";
import { createStore } from "zustand/vanilla";
import { normalizePath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import type {
	LatexCompileLog,
	LatexCompileResult,
	LatexDiagnostic,
} from "@/lib/tex/host";

export type TexBuildSnapshot = {
	jobId: string | null;
	status: "running" | "succeeded" | "failed" | "cancelled";
	logs: string[];
	diagnostics: LatexDiagnostic[];
	result: LatexCompileResult | null;
};
export const texBuildStore = createStore<{
	byRoot: Record<string, TexBuildSnapshot>;
	dependencies: Record<string, string[]>;
}>(() => ({ byRoot: {}, dependencies: {} }));

export function beginTexBuild(rootPath: string): void {
	const key = normalizePath(rootPath);
	texBuildStore.setState((state) => ({
		byRoot: {
			...state.byRoot,
			[key]: {
				jobId: null,
				status: "running",
				logs: [],
				diagnostics: [],
				result: null,
			},
		},
	}));
}

export function finishTexBuild(
	rootPath: string,
	status: TexBuildSnapshot["status"],
	error?: string,
): void {
	const key = normalizePath(rootPath);
	texBuildStore.setState((state) => {
		const snapshot = state.byRoot[key];
		if (!snapshot) return state;
		// compile:finished is the build's own verdict. The job waiter reports
		// "succeeded" whenever the task resolves, which must not hide a failure
		// or a cancel that already landed, or revive a stale running snapshot.
		const next =
			status === "succeeded" &&
			(snapshot.status === "failed" || snapshot.status === "cancelled")
				? snapshot.status
				: status;
		return {
			byRoot: {
				...state.byRoot,
				[key]: {
					...snapshot,
					status: next,
					logs:
						error && !snapshot.logs.join("\n").includes(error)
							? [...snapshot.logs, error]
							: snapshot.logs,
					...(error &&
					!snapshot.diagnostics.some((item) => item.severity === "error")
						? {
								diagnostics: [
									...snapshot.diagnostics,
									{
										path: rootPath,
										line: 1,
										column: 1,
										severity: "error" as const,
										message: error,
										source: "build" as const,
									},
								],
							}
						: {}),
				},
			},
		};
	});
}

export function setTexDependencies(rootPath: string, paths: string[]): void {
	texBuildStore.setState((state) => ({
		dependencies: {
			...state.dependencies,
			[normalizePath(rootPath)]: [
				...new Set([rootPath, ...paths].map(normalizePath)),
			],
		},
	}));
}

export function receiveTexLog(payload: LatexCompileLog): void {
	const key = normalizePath(payload.rootPath);
	const current = texBuildStore.getState().byRoot[key];
	if (
		current?.jobId &&
		current.jobId !== payload.jobId &&
		current.status === "running"
	)
		return;
	const snapshot: TexBuildSnapshot = (current?.jobId === payload.jobId ||
	!current?.jobId
		? current
		: null) ?? {
		jobId: payload.jobId,
		status: "running",
		logs: [],
		diagnostics: [],
		result: null,
	};
	texBuildStore.setState((state) => ({
		byRoot: {
			...state.byRoot,
			[key]: {
				...snapshot,
				jobId: payload.jobId,
				logs: [...snapshot.logs, payload.line],
			},
		},
	}));
}

export function receiveTexResult(payload: LatexCompileResult): void {
	const key = normalizePath(payload.rootPath);
	const current = texBuildStore.getState().byRoot[key];
	if (
		current?.jobId &&
		current.jobId !== payload.jobId &&
		current.status === "running"
	)
		return;
	texBuildStore.setState((state) => ({
		byRoot: {
			...state.byRoot,
			[key]: {
				jobId: payload.jobId,
				status: payload.success ? "succeeded" : "failed",
				logs: current?.logs ?? [],
				diagnostics: payload.diagnostics,
				result: payload,
			},
		},
	}));
	setTexDependencies(payload.rootPath, [
		...(texBuildStore.getState().dependencies[key] ?? []),
		...payload.dependencies,
	]);
}

let listeners: Promise<void> | null = null;
/** Install before enqueueing, so even a very fast compiler cannot outrun the UI. */
export function ensureTexBuildEvents(): Promise<void> {
	if (!isTauri()) return Promise.resolve();
	if (!listeners) {
		listeners = (async () => {
			const subscriptions = await Promise.allSettled([
				listen<LatexCompileLog>("compile:log", ({ payload }) =>
					receiveTexLog(payload),
				),
				listen<LatexCompileResult>("compile:finished", ({ payload }) =>
					receiveTexResult(payload),
				),
			]);
			if (subscriptions.some((result) => result.status === "rejected")) {
				for (const result of subscriptions)
					if (result.status === "fulfilled") result.value();
				listeners = null;
			}
		})();
	}
	return listeners;
}
