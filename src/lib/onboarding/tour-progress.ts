export type TourPhase = "workspace" | "reading";
export type TourProgress = {
	workspaceDone: boolean;
	readingDone: boolean;
	phase: TourPhase;
	step: number;
};
const KEY = "agentero-feature-tour-progress-v2";
const initial = (): TourProgress => ({
	workspaceDone: false,
	readingDone: false,
	phase: "workspace",
	step: 0,
});
let memory = initial();

/** A closed or interrupted tour resumes; only its explicit Done action completes a phase. */
export function readTourProgress(): TourProgress {
	try {
		const stored = JSON.parse(localStorage.getItem(KEY) ?? "null");
		if (
			stored &&
			typeof stored.workspaceDone === "boolean" &&
			typeof stored.readingDone === "boolean" &&
			(stored.phase === "workspace" || stored.phase === "reading") &&
			Number.isInteger(stored.step) &&
			stored.step >= 0
		) {
			memory = stored;
		} else memory = initial();
	} catch (error) {
		if (error instanceof SyntaxError) memory = initial();
	}
	return { ...memory };
}

export function saveTourProgress(progress: TourProgress): void {
	memory = { ...progress };
	try {
		localStorage.setItem(KEY, JSON.stringify(progress));
	} catch {
		/* Session progress remains usable. */
	}
}

export function resetTourProgress(): void {
	saveTourProgress(initial());
}

export function advanceTourPhase(
	progress: TourProgress,
	phase: TourPhase,
): TourProgress {
	return {
		...progress,
		workspaceDone: progress.workspaceDone || phase === "workspace",
		readingDone: progress.readingDone || phase === "reading",
		phase: "reading",
		step: 0,
	};
}
