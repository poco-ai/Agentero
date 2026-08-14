import {
	isVoiceDifficulty,
	isVoiceScenario,
	type VoiceDifficulty,
	type VoiceScenario,
} from "@/lib/voice-defense/protocol";

const PLANNED_DURATION_STORAGE_KEY = "agentero.voiceDefense.plannedMinutes";
const SCENARIO_STORAGE_KEY = "agentero.voiceDefense.scenario";
const LANGUAGE_STORAGE_KEY = "agentero.voiceDefense.language";
const DIFFICULTY_STORAGE_KEY = "agentero.voiceDefense.difficulty";

/** Preset defense lengths; custom minutes (1–240) are also allowed. `null` = untimed. */
export const PLANNED_DURATION_CHOICES = [null, 10, 20, 30, 45] as const;

export const MIN_CUSTOM_DURATION_MINUTES = 1;
export const MAX_CUSTOM_DURATION_MINUTES = 240;

function readStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function clampPlannedDurationMinutes(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	const rounded = Math.round(value);
	if (
		rounded < MIN_CUSTOM_DURATION_MINUTES ||
		rounded > MAX_CUSTOM_DURATION_MINUTES
	) {
		return null;
	}
	return rounded;
}

export function readStoredScenario(
	storage: Storage | null = readStorage(),
): VoiceScenario {
	if (!storage) return "defense";
	try {
		const raw = storage.getItem(SCENARIO_STORAGE_KEY);
		return isVoiceScenario(raw) ? raw : "defense";
	} catch {
		return "defense";
	}
}

export function writeStoredScenario(
	scenario: VoiceScenario,
	storage: Storage | null = readStorage(),
): void {
	if (!storage) return;
	try {
		storage.setItem(SCENARIO_STORAGE_KEY, scenario);
	} catch {
		// Best-effort preference; the session still runs without it.
	}
}

export function readStoredLanguage(
	fallback: "en" | "zh-CN",
	storage: Storage | null = readStorage(),
): "en" | "zh-CN" {
	if (!storage) return fallback;
	try {
		const raw = storage.getItem(LANGUAGE_STORAGE_KEY);
		return raw === "en" || raw === "zh-CN" ? raw : fallback;
	} catch {
		return fallback;
	}
}

export function writeStoredLanguage(
	language: "en" | "zh-CN",
	storage: Storage | null = readStorage(),
): void {
	if (!storage) return;
	try {
		storage.setItem(LANGUAGE_STORAGE_KEY, language);
	} catch {
		// Best-effort preference.
	}
}

export function readStoredDifficulty(
	storage: Storage | null = readStorage(),
): VoiceDifficulty {
	if (!storage) return "adaptive";
	try {
		const raw = storage.getItem(DIFFICULTY_STORAGE_KEY);
		return isVoiceDifficulty(raw) ? raw : "adaptive";
	} catch {
		return "adaptive";
	}
}

export function writeStoredDifficulty(
	difficulty: VoiceDifficulty,
	storage: Storage | null = readStorage(),
): void {
	if (!storage) return;
	try {
		storage.setItem(DIFFICULTY_STORAGE_KEY, difficulty);
	} catch {
		// Best-effort preference.
	}
}

export function readPlannedDurationMinutes(
	storage: Storage | null = readStorage(),
): number | null {
	if (!storage) return null;
	try {
		const raw = storage.getItem(PLANNED_DURATION_STORAGE_KEY);
		if (!raw) return null;
		if (raw === "null" || raw === "none") return null;
		return clampPlannedDurationMinutes(Number(raw));
	} catch {
		return null;
	}
}

export function writePlannedDurationMinutes(
	minutes: number | null,
	storage: Storage | null = readStorage(),
): void {
	if (!storage) return;
	try {
		if (minutes === null) {
			storage.removeItem(PLANNED_DURATION_STORAGE_KEY);
			return;
		}
		const clamped = clampPlannedDurationMinutes(minutes);
		if (clamped === null) {
			storage.removeItem(PLANNED_DURATION_STORAGE_KEY);
			return;
		}
		storage.setItem(PLANNED_DURATION_STORAGE_KEY, String(clamped));
	} catch {
		// Best-effort preference; the session still runs without it.
	}
}
