const PREPARATION_RECOVERY_STORAGE_KEY = "agentero.voiceDefense.preparation";

export type PreparationRecoveryRecord = {
	vaultPath: string;
	paperPath: string;
	runId: string;
};

function readStorage(): Storage | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function readPreparationRecovery(
	storage: Storage | null = readStorage(),
): PreparationRecoveryRecord | null {
	if (!storage) return null;
	try {
		const raw = storage.getItem(PREPARATION_RECOVERY_STORAGE_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<PreparationRecoveryRecord>;
		if (
			typeof value.vaultPath !== "string" ||
			typeof value.paperPath !== "string" ||
			typeof value.runId !== "string" ||
			!value.vaultPath.trim() ||
			!value.paperPath.trim() ||
			!value.runId.trim()
		) {
			storage.removeItem(PREPARATION_RECOVERY_STORAGE_KEY);
			return null;
		}
		return {
			vaultPath: value.vaultPath,
			paperPath: value.paperPath,
			runId: value.runId,
		};
	} catch {
		return null;
	}
}

export function writePreparationRecovery(
	record: PreparationRecoveryRecord,
	storage: Storage | null = readStorage(),
): void {
	if (!storage) return;
	try {
		storage.setItem(PREPARATION_RECOVERY_STORAGE_KEY, JSON.stringify(record));
	} catch {
		// Session storage is best-effort; the Vault manifest remains authoritative.
	}
}

export function clearPreparationRecovery(
	runId?: string,
	storage: Storage | null = readStorage(),
): void {
	if (!storage) return;
	try {
		if (!runId || readPreparationRecovery(storage)?.runId === runId) {
			storage.removeItem(PREPARATION_RECOVERY_STORAGE_KEY);
		}
	} catch {
		// Ignore storage failures; they must not affect the Voice flow.
	}
}

export function canRecoverPreparation(
	record: PreparationRecoveryRecord | null,
	vaultPath: string | null,
	paperPath: string | null,
): record is PreparationRecoveryRecord {
	return Boolean(
		record && vaultPath === record.vaultPath && paperPath === record.paperPath,
	);
}
