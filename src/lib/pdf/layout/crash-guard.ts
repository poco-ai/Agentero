/**
 * Crash-loop guard for PP-DocLayoutV3 layout analysis.
 *
 * The analysis runs inside the main WebView (PDFium wasm rendering + ONNX
 * inference). On memory pressure macOS can terminate the WebContent process;
 * wry then reloads the page and restored paper tabs would immediately re-queue
 * the same analysis, crashing again in an endless loop.
 *
 * An attempt is recorded in `localStorage` right before ONNX analysis starts
 * and cleared on any normal outcome (success, failure, cancellation). A record
 * that is still "in flight" after a reload therefore means the WebView died
 * mid-analysis. After MAX_CRASHES such records the automatic paths stop
 * re-queuing that paper; a manual re-run resets the guard.
 */

const STORAGE_KEY = "agentero.pdfLayout.crashGuard";

/** Automatic analysis is skipped after this many mid-run WebView crashes. */
const MAX_CRASHES = 2;

/** Crash records older than this no longer block automatic analysis. */
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type GuardRecord = {
	attempts: number;
	inFlight: boolean;
	updatedAt: number;
};

type GuardState = Record<string, GuardRecord>;

function normalizePaperKey(paperAbsPath: string): string {
	return paperAbsPath.replace(/\\/g, "/").replace(/\/+$/, "");
}

function readState(): GuardState {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return {};
		const state: GuardState = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (
				typeof value === "object" &&
				value !== null &&
				typeof (value as GuardRecord).attempts === "number" &&
				typeof (value as GuardRecord).inFlight === "boolean" &&
				typeof (value as GuardRecord).updatedAt === "number"
			) {
				state[key] = value as GuardRecord;
			}
		}
		return state;
	} catch {
		return {};
	}
}

function writeState(state: GuardState): void {
	if (typeof localStorage === "undefined") return;
	try {
		const now = Date.now();
		const compact: GuardState = {};
		for (const [key, record] of Object.entries(state)) {
			if (now - record.updatedAt <= RECORD_TTL_MS) compact[key] = record;
		}
		if (Object.keys(compact).length === 0) {
			localStorage.removeItem(STORAGE_KEY);
			return;
		}
		localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
	} catch {
		// Guard bookkeeping must never break the analysis itself.
	}
}

/**
 * Record that ONNX analysis is about to run for this paper.
 * Counts prior in-flight records as crashes (the WebView never came back to
 * clear them), so the counter survives WebContent process terminations.
 */
export function beginLayoutAnalysisAttempt(paperAbsPath: string): void {
	const key = normalizePaperKey(paperAbsPath);
	if (!key) return;
	const state = readState();
	const previous = state[key];
	state[key] = {
		attempts: previous?.inFlight ? previous.attempts + 1 : 1,
		inFlight: true,
		updatedAt: Date.now(),
	};
	writeState(state);
}

/** Clear the record on any normal outcome (success, failure, cancellation). */
export function finishLayoutAnalysisAttempt(paperAbsPath: string): void {
	const key = normalizePaperKey(paperAbsPath);
	if (!key) return;
	const state = readState();
	if (!(key in state)) return;
	delete state[key];
	writeState(state);
}

/**
 * Whether automatic paths must not re-run analysis for this paper because the
 * previous runs kept killing the WebView mid-analysis.
 */
export function shouldSkipAutoLayoutAnalysis(paperAbsPath: string): boolean {
	const key = normalizePaperKey(paperAbsPath);
	if (!key) return false;
	const record = readState()[key];
	if (!record?.inFlight) return false;
	if (Date.now() - record.updatedAt > RECORD_TTL_MS) return false;
	return record.attempts >= MAX_CRASHES;
}

/** Manual re-run: give automatic analysis a fresh set of attempts. */
export function resetLayoutAnalysisCrashGuard(paperAbsPath: string): void {
	finishLayoutAnalysisAttempt(paperAbsPath);
}
