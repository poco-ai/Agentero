import type { FileNode } from "@/lib/vault";
import {
	fingerprintVaultFile,
	joinVaultPath,
	listVaultDirChildren,
	readVaultFile,
} from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import {
	DEFENSE_PREPARATION_SCHEMA_VERSION,
	type DefenseMaterialSnapshot,
	isSafeVaultRelativePath,
	type PaperSelectionSnapshot,
	type PaperSnapshot,
	type PaperSnapshotSource,
} from "@/lib/voice-defense/preparation/schema";

export type PaperSnapshotInput = {
	vaultRoot: string;
	/** Legacy primary material path; new callers also pass `materials`. */
	paperPath: string;
	materials?: DefenseMaterialSnapshot[];
	/** User-authored guidance applied to every preparation Agent. */
	instruction?: string;
	title?: string;
	metadata?: Record<string, string | number | boolean | null | undefined>;
	selections?: PaperSelectionSnapshot[];
};

export type PaperSourceStat = {
	size?: number;
	modifiedAt?: string;
	sha256?: string;
};

export type PaperSnapshotDeps = {
	listDirectory: (
		vaultRoot: string,
		absolutePath: string,
	) => Promise<FileNode[]>;
	readText: (absolutePath: string) => Promise<string>;
	fingerprintFile: (
		vaultRoot: string,
		relativePath: string,
	) => Promise<PaperSourceStat | undefined>;
	hashText: (content: string) => Promise<string>;
	now: () => string;
};

function normalizeRelativePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function assertMaterialPath(path: string): string {
	const normalized = normalizeRelativePath(path);
	if (
		!normalized ||
		normalized.split("/").some((part) => part === "." || part === "..") ||
		/^([a-zA-Z]:|remote:)/.test(normalized)
	) {
		throw new Error("material path must be a safe Vault-relative path");
	}
	return normalized;
}

function relativeToVault(vaultRoot: string, absolutePath: string): string {
	const root = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	const absolute = absolutePath.replace(/\\/g, "/");
	if (absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1);
	if (isRemoteVaultHandle(vaultRoot)) {
		const slash = absolute.indexOf("/");
		return slash === -1 ? "" : absolute.slice(slash + 1);
	}
	throw new Error(`snapshot source is outside the Vault: ${absolutePath}`);
}

function snapshotSourceKind(path: string): PaperSnapshotSource["kind"] | null {
	const lower = path.toLowerCase();
	if (lower.endsWith(".pdf")) return "pdf";
	if (/\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/.test(lower)) return "image";
	if (/\.(csv|tsv|jsonl?|ya?ml|xml|parquet|arrow|npy|npz)$/.test(lower)) {
		return "data";
	}
	if (
		/\.(md|mdx|markdown|txt|rst|org)$/.test(lower) ||
		lower.endsWith(".tex") ||
		lower.endsWith(".ltx") ||
		lower.endsWith(".bib") ||
		lower.endsWith(".bbl")
	) {
		return "text";
	}
	return null;
}

async function collectFiles(
	vaultRoot: string,
	directory: string,
	deps: PaperSnapshotDeps,
): Promise<FileNode[]> {
	const children = await deps.listDirectory(vaultRoot, directory);
	const result: FileNode[] = [];
	for (const child of children) {
		if (child.kind === "file") {
			result.push(child);
			continue;
		}
		result.push(...(await collectFiles(vaultRoot, child.path, deps)));
	}
	return result;
}

function normalizeMetadata(
	metadata: PaperSnapshotInput["metadata"],
): Record<string, string | number | boolean | null> {
	const normalized: Record<string, string | number | boolean | null> = {};
	for (const key of Object.keys(metadata ?? {}).sort()) {
		const value = metadata?.[key];
		if (value !== undefined) normalized[key] = value;
	}
	return normalized;
}

function canonicalSnapshotInput(input: {
	paperPath: string;
	materials: DefenseMaterialSnapshot[];
	instruction: string;
	title?: string;
	metadata: Record<string, string | number | boolean | null>;
	selections: PaperSelectionSnapshot[];
	sources: PaperSnapshotSource[];
}): string {
	return JSON.stringify({
		paperPath: input.paperPath,
		materials: input.materials,
		instruction: input.instruction,
		title: input.title ?? null,
		metadata: input.metadata,
		selections: input.selections,
		sources: [...input.sources]
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((source) => ({
				path: source.path,
				kind: source.kind,
				size: source.size ?? null,
				modifiedAt: source.modifiedAt ?? null,
				sha256: source.sha256 ?? null,
			})),
	});
}

export async function sha256Text(content: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function createDefaultPaperSnapshotDeps(): PaperSnapshotDeps {
	return {
		listDirectory: listVaultDirChildren,
		readText: readVaultFile,
		fingerprintFile: async (vaultRoot, relativePath) => {
			const info = await fingerprintVaultFile(vaultRoot, relativePath);
			return {
				size: info.size,
				modifiedAt: new Date(info.mtime * 1000).toISOString(),
				sha256: info.hash,
			};
		},
		hashText: sha256Text,
		now: () => new Date().toISOString(),
	};
}

export async function createPaperSnapshot(
	input: PaperSnapshotInput,
	deps: PaperSnapshotDeps = createDefaultPaperSnapshotDeps(),
): Promise<PaperSnapshot> {
	const paperPath = assertMaterialPath(input.paperPath);
	const materials = (
		input.materials?.length
			? input.materials
			: [{ path: paperPath, kind: "directory" as const }]
	).map((material) => ({
		path: assertMaterialPath(material.path),
		kind: material.kind,
		title: material.title?.trim() || undefined,
	}));
	const uniqueMaterialPaths = new Set<string>();
	for (const material of materials) {
		if (uniqueMaterialPaths.has(material.path)) {
			throw new Error(`duplicate defense material: ${material.path}`);
		}
		uniqueMaterialPaths.add(material.path);
	}
	const selectedFiles = new Map<string, string>();
	for (const material of materials) {
		const absolutePath = joinVaultPath(input.vaultRoot, material.path);
		if (material.kind === "file") {
			selectedFiles.set(material.path, absolutePath);
			continue;
		}
		for (const file of await collectFiles(
			input.vaultRoot,
			absolutePath,
			deps,
		)) {
			const relativePath = normalizeRelativePath(
				relativeToVault(input.vaultRoot, file.path),
			);
			selectedFiles.set(relativePath, file.path);
		}
	}
	const files = [...selectedFiles.entries()]
		.filter(([path]) => snapshotSourceKind(path) !== null)
		.sort(([a], [b]) => a.localeCompare(b));
	const sources: PaperSnapshotSource[] = [];
	const warnings: string[] = [];

	for (const [path, absolutePath] of files) {
		if (
			!isSafeVaultRelativePath(path) ||
			!materials.some((material) =>
				material.kind === "file"
					? path === material.path
					: path.startsWith(`${material.path}/`),
			)
		) {
			throw new Error(`snapshot source is outside selected materials: ${path}`);
		}
		const kind = snapshotSourceKind(path);
		if (!kind) continue;
		const stat = await deps.fingerprintFile(input.vaultRoot, path);
		if (kind !== "text") {
			const sha256 = stat?.sha256;
			if (!sha256 && stat?.size === undefined && !stat?.modifiedAt) {
				warnings.push(
					`Binary source change detection is limited because metadata is unavailable: ${path}`,
				);
			}
			sources.push({
				path,
				kind,
				size: stat?.size,
				modifiedAt: stat?.modifiedAt,
				sha256,
			});
			continue;
		}

		const content = stat?.sha256
			? undefined
			: await deps.readText(absolutePath);
		sources.push({
			path,
			kind: "text",
			size: stat?.size ?? new TextEncoder().encode(content ?? "").byteLength,
			modifiedAt: stat?.modifiedAt,
			sha256: stat?.sha256 ?? (await deps.hashText(content ?? "")),
		});
	}

	if (sources.length === 0) {
		warnings.push(
			"No supported document, LaTeX, figure, experiment data, or PDF source was found in the selected materials.",
		);
	}
	if (
		sources.length > 0 &&
		sources.every((source) => source.path.toLowerCase().endsWith("/notes.md"))
	) {
		warnings.push(
			"Only NOTES.md is available; full-paper verification is limited.",
		);
	}

	const selections = (input.selections ?? []).map((selection) => {
		const sourcePath = selection.sourcePath
			? normalizeRelativePath(selection.sourcePath)
			: undefined;
		if (sourcePath && !isSafeVaultRelativePath(sourcePath)) {
			throw new Error(`selection source must be Vault-relative: ${sourcePath}`);
		}
		if (
			selection.page !== undefined &&
			(!Number.isInteger(selection.page) || selection.page < 1)
		) {
			throw new Error("selection page must be a positive integer");
		}
		return {
			text: selection.text,
			sourcePath,
			page: selection.page,
		};
	});
	const metadata = normalizeMetadata(input.metadata);
	const instruction = input.instruction?.trim() ?? "";
	const snapshotSha256 = await deps.hashText(
		canonicalSnapshotInput({
			paperPath,
			materials,
			instruction,
			title: input.title,
			metadata,
			selections,
			sources,
		}),
	);

	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		paperPath,
		materials,
		instruction,
		title: input.title,
		metadata,
		selections,
		sources,
		snapshotSha256,
		warnings,
		createdAt: deps.now(),
	};
}

export type PreparationStaleness = {
	stale: boolean;
	changedPaths: string[];
};

export function detectPreparationStaleness(
	previous: PaperSnapshot,
	current: PaperSnapshot,
): PreparationStaleness {
	if (previous.snapshotSha256 === current.snapshotSha256) {
		return { stale: false, changedPaths: [] };
	}
	const before = new Map(
		previous.sources.map((source) => [source.path, source]),
	);
	const after = new Map(current.sources.map((source) => [source.path, source]));
	const changedPaths = new Set<string>();
	for (const path of new Set([...before.keys(), ...after.keys()])) {
		const a = before.get(path);
		const b = after.get(path);
		if (
			!a ||
			!b ||
			a.sha256 !== b.sha256 ||
			a.size !== b.size ||
			a.modifiedAt !== b.modifiedAt
		) {
			changedPaths.add(path);
		}
	}
	if (changedPaths.size === 0) changedPaths.add("paper metadata or selections");
	return { stale: true, changedPaths: [...changedPaths].sort() };
}
