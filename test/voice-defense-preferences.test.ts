import { afterEach, describe, expect, it } from "vitest";
import {
	clampPlannedDurationMinutes,
	readPlannedDurationMinutes,
	readStoredDifficulty,
	readStoredLanguage,
	readStoredScenario,
	writePlannedDurationMinutes,
	writeStoredDifficulty,
	writeStoredLanguage,
	writeStoredScenario,
} from "@/lib/voice-defense/preferences";

class MemoryStorage implements Storage {
	private readonly data = new Map<string, string>();

	get length(): number {
		return this.data.size;
	}

	clear(): void {
		this.data.clear();
	}

	getItem(key: string): string | null {
		return this.data.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.data.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.data.delete(key);
	}

	setItem(key: string, value: string): void {
		this.data.set(key, value);
	}
}

describe("voice defense preferences", () => {
	const storage = new MemoryStorage();

	afterEach(() => {
		storage.clear();
	});

	it("clamps custom duration to 1–240 minutes", () => {
		expect(clampPlannedDurationMinutes(Number.NaN)).toBeNull();
		expect(clampPlannedDurationMinutes(0)).toBeNull();
		expect(clampPlannedDurationMinutes(1)).toBe(1);
		expect(clampPlannedDurationMinutes(12.4)).toBe(12);
		expect(clampPlannedDurationMinutes(240)).toBe(240);
		expect(clampPlannedDurationMinutes(241)).toBeNull();
	});

	it("round-trips scenario, language, difficulty, and duration", () => {
		writeStoredScenario("seminar", storage);
		writeStoredLanguage("en", storage);
		writeStoredDifficulty("advanced", storage);
		writePlannedDurationMinutes(30, storage);

		expect(readStoredScenario(storage)).toBe("seminar");
		expect(readStoredLanguage("zh-CN", storage)).toBe("en");
		expect(readStoredDifficulty(storage)).toBe("advanced");
		expect(readPlannedDurationMinutes(storage)).toBe(30);
	});

	it("treats untimed and invalid stored durations as null", () => {
		writePlannedDurationMinutes(null, storage);
		expect(readPlannedDurationMinutes(storage)).toBeNull();

		storage.setItem("agentero.voiceDefense.plannedMinutes", "none");
		expect(readPlannedDurationMinutes(storage)).toBeNull();

		storage.setItem("agentero.voiceDefense.plannedMinutes", "999");
		expect(readPlannedDurationMinutes(storage)).toBeNull();
	});

	it("falls back when stored values are unknown", () => {
		storage.setItem("agentero.voiceDefense.scenario", "debate");
		storage.setItem("agentero.voiceDefense.language", "fr");
		storage.setItem("agentero.voiceDefense.difficulty", "nightmare");

		expect(readStoredScenario(storage)).toBe("defense");
		expect(readStoredLanguage("zh-CN", storage)).toBe("zh-CN");
		expect(readStoredDifficulty(storage)).toBe("adaptive");
	});
});
