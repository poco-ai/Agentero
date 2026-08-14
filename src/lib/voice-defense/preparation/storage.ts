import {
	joinVaultPath,
	listVaultDirChildren,
	readVaultFile,
	writeVaultFile,
	writeVaultFileAtomic,
} from "@/lib/vault";
import {
	type DefenseArtifact,
	type DefensePreparationManifest,
	type DefensePreparationRole,
	type DefensePreparationSummary,
	parseDefenseArtifact,
	parseDefensePreparationManifest,
} from "@/lib/voice-defense/preparation/schema";

export const DEFENSE_PREPARATIONS_DIRECTORY = "voice-defense/preparations";

export type PreparationStorageEntry = {
	name: string;
	kind: "file" | "directory";
};

export type PreparationStorage = {
	readText(relativePath: string): Promise<string>;
	writeText(relativePath: string, content: string): Promise<void>;
	/** Must commit complete content with a same-filesystem atomic rename. */
	writeTextAtomic(relativePath: string, content: string): Promise<void>;
	list(relativeDirectory: string): Promise<PreparationStorageEntry[]>;
};

export type VaultPreparationStorageOptions = {
	/** Unified local/remote Host helper injection point. */
	writeVaultFileAtomic?: (
		vaultRoot: string,
		relativePath: string,
		content: string,
	) => Promise<void>;
};

export class AtomicVaultWriteUnavailableError extends Error {
	constructor(message = "atomic Vault file replacement is unavailable") {
		super(message);
		this.name = "AtomicVaultWriteUnavailableError";
	}
}

function safeSegment(value: string, label: string): string {
	if (!value || !/^[a-zA-Z0-9._-]+$/.test(value)) {
		throw new Error(`${label} contains unsupported path characters`);
	}
	return value;
}

function normalizeRelativePath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (
		!normalized ||
		normalized.split("/").some((part) => part === "." || part === "..")
	) {
		throw new Error("preparation storage path must be Vault-relative");
	}
	return normalized;
}

export function preparationRunDirectory(runId: string): string {
	return `${DEFENSE_PREPARATIONS_DIRECTORY}/${safeSegment(runId, "runId")}`;
}

export function preparationManifestPath(runId: string): string {
	return `${preparationRunDirectory(runId)}/manifest.json`;
}

export function preparationBriefPath(runId: string): string {
	return `${preparationRunDirectory(runId)}/defense-brief.md`;
}

export function preparationArtifactPath(
	runId: string,
	role: DefensePreparationRole,
	attempt: number,
): string {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new Error("attempt must be a positive integer");
	}
	return `${preparationRunDirectory(runId)}/artifacts/${role}.attempt-${attempt}.json`;
}

export function createVaultPreparationStorage(
	vaultRoot: string,
	options: VaultPreparationStorageOptions = {},
): PreparationStorage {
	return {
		readText: (relativePath) =>
			readVaultFile(
				joinVaultPath(vaultRoot, normalizeRelativePath(relativePath)),
			),
		writeText: (relativePath, content) =>
			writeVaultFile(
				joinVaultPath(vaultRoot, normalizeRelativePath(relativePath)),
				content,
			),
		writeTextAtomic: async (relativePath, content) => {
			const normalized = normalizeRelativePath(relativePath);
			if (options.writeVaultFileAtomic) {
				await options.writeVaultFileAtomic(vaultRoot, normalized, content);
				return;
			}
			try {
				await writeVaultFileAtomic(vaultRoot, normalized, content);
			} catch (error) {
				throw new AtomicVaultWriteUnavailableError(
					`atomic Vault write failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		list: async (relativeDirectory) => {
			const children = await listVaultDirChildren(
				vaultRoot,
				joinVaultPath(vaultRoot, normalizeRelativePath(relativeDirectory)),
			);
			return children.map((child) => ({
				name: child.name,
				kind: child.kind,
			}));
		},
	};
}

export function serializePreparationManifest(
	manifest: DefensePreparationManifest,
): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function serializeDefenseArtifact(artifact: DefenseArtifact): string {
	return `${JSON.stringify(artifact, null, 2)}\n`;
}

export async function writePreparationManifest(
	storage: PreparationStorage,
	manifest: DefensePreparationManifest,
): Promise<void> {
	await storage.writeTextAtomic(
		preparationManifestPath(manifest.runId),
		serializePreparationManifest(manifest),
	);
}

export async function writeDefenseArtifact(
	storage: PreparationStorage,
	artifact: DefenseArtifact,
): Promise<void> {
	await storage.writeTextAtomic(
		artifact.contentPath,
		serializeDefenseArtifact(artifact),
	);
}

export async function loadDefenseArtifact(
	storage: PreparationStorage,
	relativePath: string,
): Promise<DefenseArtifact | null> {
	let raw: string;
	try {
		raw = await storage.readText(normalizeRelativePath(relativePath));
	} catch {
		return null;
	}
	try {
		return parseDefenseArtifact(JSON.parse(raw));
	} catch {
		return null;
	}
}

export async function writeDefenseBrief(
	storage: PreparationStorage,
	runId: string,
	markdown: string,
): Promise<string> {
	const path = preparationBriefPath(runId);
	await storage.writeTextAtomic(path, markdown);
	return path;
}

export async function loadDefensePreparationManifest(
	storage: PreparationStorage,
	runId: string,
): Promise<DefensePreparationManifest | null> {
	let raw: string;
	try {
		raw = await storage.readText(preparationManifestPath(runId));
	} catch {
		return null;
	}
	try {
		return parseDefensePreparationManifest(JSON.parse(raw));
	} catch {
		return null;
	}
}

export async function listDefensePreparationManifests(
	storage: PreparationStorage,
): Promise<DefensePreparationManifest[]> {
	let entries: PreparationStorageEntry[];
	try {
		entries = await storage.list(DEFENSE_PREPARATIONS_DIRECTORY);
	} catch {
		return [];
	}
	const manifests = await Promise.all(
		entries
			.filter((entry) => entry.kind === "directory")
			.map((entry) => loadDefensePreparationManifest(storage, entry.name)),
	);
	return manifests
		.filter((manifest): manifest is DefensePreparationManifest => !!manifest)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function summarizeDefensePreparation(
	manifest: DefensePreparationManifest,
): DefensePreparationSummary {
	return {
		runId: manifest.runId,
		paperPath: manifest.paperPath,
		status: manifest.status,
		stale: manifest.stale,
		partial: manifest.partial,
		briefPath: manifest.briefPath,
		createdAt: manifest.createdAt,
		updatedAt: manifest.updatedAt,
		snapshotSha256: manifest.snapshot.snapshotSha256,
		materials: manifest.snapshot.materials.map((material) => material.path),
	};
}
