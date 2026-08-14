import { afterEach, describe, expect, it } from "vitest";
import {
	canRecoverPreparation,
	clearPreparationRecovery,
	readPreparationRecovery,
	writePreparationRecovery,
} from "@/lib/voice-defense/preparation-recovery";

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

describe("voice defense preparation recovery", () => {
	const storage = new MemoryStorage();
	const record = {
		vaultPath: "/vault",
		paperPath: "papers/demo",
		runId: "run-1",
	};

	afterEach(() => {
		storage.clear();
	});

	it("round-trips a valid recovery record", () => {
		writePreparationRecovery(record, storage);
		expect(readPreparationRecovery(storage)).toEqual(record);
	});

	it("drops malformed records", () => {
		storage.setItem(
			"agentero.voiceDefense.preparation",
			JSON.stringify({ vaultPath: "/vault", runId: "run-1" }),
		);
		expect(readPreparationRecovery(storage)).toBeNull();
		expect(storage.getItem("agentero.voiceDefense.preparation")).toBeNull();
	});

	it("only clears the matching run", () => {
		writePreparationRecovery(record, storage);
		clearPreparationRecovery("run-2", storage);
		expect(readPreparationRecovery(storage)).toEqual(record);
		clearPreparationRecovery("run-1", storage);
		expect(readPreparationRecovery(storage)).toBeNull();
	});

	it("matches recovery to the current vault and paper", () => {
		expect(canRecoverPreparation(record, "/vault", "papers/demo")).toBe(true);
		expect(canRecoverPreparation(record, "/other", "papers/demo")).toBe(false);
		expect(canRecoverPreparation(null, "/vault", "papers/demo")).toBe(false);
	});
});
