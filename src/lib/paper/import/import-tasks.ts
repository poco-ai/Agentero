/**
 * Renderer executor for `import` jobs.
 *
 * The JobCenter schedules paper imports (magic wand / local PDF / Skill install
 * / 广场 / Cool Papers notes); each flow keeps its own orchestration in its
 * feature module and is dispatched here by `params.mode`. Terminal state is
 * reported once, so handlers just do the work and throw on failure.
 */

import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import {
	registerTaskExecutor,
	type TaskExecutorContext,
	throwIfTaskCancelled,
} from "@/lib/core/tasks";
import { runCoolNotesImportJob } from "@/lib/paper/coolpapers";
import {
	runLocalPdfImportJob,
	runLookupBatchImportJob,
	runLookupImportJob,
	runSkillImportJob,
} from "@/lib/paper/import-actions";
import { runPlazaImportJob } from "@/lib/plaza/import";

export type ImportMode =
	| "lookup"
	| "lookupBatch"
	| "skillLookup"
	| "skill"
	| "localPdf"
	| "plaza"
	| "coolNotes";

const HANDLERS: Record<
	ImportMode,
	(ctx: TaskExecutorContext) => Promise<void>
> = {
	lookup: runLookupImportJob,
	lookupBatch: runLookupBatchImportJob,
	skillLookup: runLookupImportJob,
	skill: runSkillImportJob,
	localPdf: runLocalPdfImportJob,
	plaza: runPlazaImportJob,
	coolNotes: runCoolNotesImportJob,
};

/** Register the renderer-side `import` executor (before `startTaskRuntime`). */
export function registerImportTaskExecutor(): void {
	registerTaskExecutor("import", runImportJob);
}

function importJobMode(params: unknown): ImportMode | null {
	const mode =
		params && typeof params === "object"
			? (params as { mode?: unknown }).mode
			: undefined;
	return typeof mode === "string" && Object.hasOwn(HANDLERS, mode)
		? (mode as ImportMode)
		: null;
}

async function runImportJob(ctx: TaskExecutorContext): Promise<void> {
	const mode = importJobMode(ctx.params);
	if (!mode) {
		throw new Error(`unknown import mode: ${JSON.stringify(ctx.params)}`);
	}
	try {
		await HANDLERS[mode](ctx);
		throwIfTaskCancelled(ctx);
		await ctx.report({ progress: 100, state: "succeeded" });
	} catch (error) {
		const cancelled =
			ctx.signal.aborted || isBackgroundTaskCancelledError(error);
		await ctx.report({
			state: cancelled ? "cancelled" : "failed",
			error: cancelled ? undefined : errorText(error),
		});
	}
}
