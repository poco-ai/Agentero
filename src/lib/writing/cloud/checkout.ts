import { readFile, remove } from "@tauri-apps/plugin-fs";
import * as Y from "yjs";
import { z } from "zod";
import i18n from "@/i18n";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault/path";
import { refreshTree } from "@/lib/vault/store";
import {
	createWritingDirectory,
	type ExplicitWritingProject,
	explicitWritingProjectForPath,
	isWritingPathSegment,
	listExplicitWritingProjects,
	validateWritingProjectForSharing,
	type WritingManifest,
	writeWritingManifest,
} from "../project-manifest";
import {
	type CloudProject,
	contentRequest,
	issueCloudTicket,
	provisionCloudProject,
	uploadWritingAsset,
	WritingApiError,
} from "./api";
import {
	ensureWritingDirectory,
	sameDiskFile,
	scanWritingDisk,
	sha256,
	writeProjection,
} from "./disk";
import {
	type WritingImport,
	type WritingRole,
	type WritingSessionTicket,
	writingRole,
} from "./protocol/contracts";
import { type AssetReference, readWritingSnapshot } from "./protocol/project";
import { type Projection, snapshotProjection } from "./reconcile";

const persisted = z.object({
	bootstrapping: z.boolean().optional(),
	role: writingRole,
	state: z.string(),
	projection: z.record(
		z.string(),
		z.discriminatedUnion("kind", [
			z.object({ path: z.string(), kind: z.literal("directory") }),
			z.object({ path: z.string(), kind: z.literal("text"), text: z.string() }),
			z.object({
				path: z.string(),
				kind: z.literal("asset"),
				sha256: z.string(),
			}),
		]),
	),
	manifest: z
		.object({
			mainFile: z.string(),
			compiler: z.enum(["pdflatex", "xelatex", "lualatex"]),
		})
		.optional(),
});

export type LocalCheckout = z.infer<typeof persisted>;
export type ProjectBuildSettings = Pick<
	WritingManifest,
	"mainFile" | "compiler"
>;

const listeners = new Set<() => void>();

export function onCheckoutChange(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function announceCheckoutChange() {
	for (const listener of listeners) listener();
}

export async function readCheckout(vault: string, id: string) {
	const value = await callApi(() =>
		commands.writingCloudState(vault, id, null),
	);
	return value ? persisted.parse(JSON.parse(value)) : null;
}

export function saveCheckout(
	vault: string,
	id: string,
	role: WritingRole,
	doc: Y.Doc,
	projection: Projection,
	manifest: ProjectBuildSettings,
	bootstrapping?: boolean,
) {
	const state = Y.encodeStateAsUpdate(doc);
	const value = JSON.stringify({
		role,
		state: toBase64(state),
		bootstrapping,
		projection,
		manifest,
	} satisfies LocalCheckout);
	return callApi(() => commands.writingCloudState(vault, id, value));
}

function toBase64(state: Uint8Array) {
	let binary = "";
	for (let index = 0; index < state.length; index += 16_384)
		binary += String.fromCharCode(...state.subarray(index, index + 16_384));
	return btoa(binary);
}

export function restoreCheckout(checkout: LocalCheckout) {
	const doc = new Y.Doc();
	Y.applyUpdate(
		doc,
		Uint8Array.from(atob(checkout.state), (value) => value.charCodeAt(0)),
		"sqlite",
	);
	return doc;
}

export async function removeCheckout(vault: string, id: string) {
	await callApi(() => commands.writingCloudState(vault, id, ""));
	announceCheckoutChange();
}

async function fetchDocument(ticket: WritingSessionTicket, projectId: string) {
	const state = await contentRequest(ticket, projectId, "state");
	const doc = new Y.Doc();
	try {
		Y.applyUpdate(doc, new Uint8Array(await state.arrayBuffer()), "server");
		return doc;
	} catch (error) {
		doc.destroy();
		throw error;
	}
}

export async function fetchAsset(
	ticket: WritingSessionTicket,
	projectId: string,
	asset: AssetReference,
) {
	const response = await contentRequest(
		ticket,
		projectId,
		`assets/${asset.assetVersionId}`,
	);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if ((await sha256(bytes)) !== asset.sha256)
		throw new Error(i18n.t("sidebar:writing.cloudInvalidAttachment"));
	return bytes;
}

async function attachMatchingCheckout(
	vault: string,
	project: ExplicitWritingProject,
	doc: Y.Doc,
	role: WritingRole,
) {
	const disk = await scanWritingDisk(project);
	const snapshot = readWritingSnapshot(doc);
	const projection = snapshotProjection(doc);
	const shared = Object.values(projection);
	const entry = snapshot.files.find(
		(file) => file.id === snapshot.mainFileId,
	)?.path;
	if (
		entry !== project.manifest.mainFile ||
		snapshot.compiler !== project.manifest.compiler ||
		disk.size !== shared.length ||
		shared.some((file) => !sameDiskFile(disk.get(file.path), file))
	)
		throw new Error(i18n.t("sidebar:writing.cloudCheckoutDiffers"));
	await saveCheckout(
		vault,
		project.manifest.projectId,
		role,
		doc,
		projection,
		project.manifest,
	);
	announceCheckoutChange();
}

export async function publishWritingCheckout(
	vault: string,
	projectDirectory: string,
) {
	const project = await validateWritingProjectForSharing(
		vault,
		projectDirectory,
	);
	const id = project.manifest.projectId;
	const binding = await readCheckout(vault, id);
	if (binding && !binding.bootstrapping) return;
	const disk = await scanWritingDisk(project);
	const main = disk.get(project.manifest.mainFile);
	if (main?.kind !== "text")
		throw new Error(i18n.t("sidebar:writing.missingMainFile"));
	// Check the Vault mirror policy before sending project bytes. The empty
	// bootstrap remains local and is removed if the remote bootstrap fails.
	const empty = new Y.Doc();
	try {
		await saveCheckout(vault, id, "owner", empty, {}, project.manifest, true);
	} finally {
		empty.destroy();
	}
	try {
		await provisionCloudProject(id, project.manifest.name);
		const ticket = await issueCloudTicket(id);
		const existing = await fetchDocument(ticket, id).catch((error) => {
			if (error instanceof WritingApiError && error.status === 409) return null;
			throw error;
		});
		if (existing) {
			try {
				await attachMatchingCheckout(vault, project, existing, ticket.role);
				return;
			} finally {
				existing.destroy();
			}
		}
		const files: WritingImport["files"] = [];
		for (const file of disk.values()) {
			if (file.kind === "asset") {
				const bytes = await readFile(
					joinVaultPath(project.directory, file.path),
				);
				if ((await sha256(bytes)) !== file.sha256)
					throw new Error(i18n.t("sidebar:writing.cloudFileChanged"));
				const { assetVersionId, sha256: hash } = await uploadWritingAsset(
					ticket,
					id,
					bytes,
				);
				files.push({
					path: file.path,
					kind: "asset",
					assetVersionId,
					sha256: hash,
				});
			} else files.push(file);
		}
		await contentRequest(ticket, id, "import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				files,
				mainFile: project.manifest.mainFile,
				compiler: project.manifest.compiler,
			}),
		});
		const doc = await fetchDocument(ticket, id);
		try {
			await saveCheckout(
				vault,
				id,
				ticket.role,
				doc,
				snapshotProjection(doc),
				project.manifest,
			);
		} finally {
			doc.destroy();
		}
	} catch (error) {
		await removeCheckout(vault, id);
		throw error;
	}
	announceCheckoutChange();
}

export async function downloadWritingCheckout(
	vault: string,
	collection: string,
	project: CloudProject,
	name: string,
) {
	const existing = (await listExplicitWritingProjects(vault)).find(
		(item) => item.manifest.projectId === project.id,
	);
	if (existing) {
		const binding = await readCheckout(vault, project.id);
		if (binding && !binding.bootstrapping) return existing.root;
		const ticket = await issueCloudTicket(project.id);
		const document = await fetchDocument(ticket, project.id);
		try {
			await attachMatchingCheckout(
				vault,
				await validateWritingProjectForSharing(vault, existing.directory),
				document,
				ticket.role,
			);
			return existing.root;
		} finally {
			document.destroy();
		}
	}
	const folder = name.trim();
	const relative = vaultRelativePath(vault, collection);
	if (
		!isWritingPathSegment(folder) ||
		!relative ||
		(relative !== "thesis" && !relative.startsWith("thesis/")) ||
		(await explicitWritingProjectForPath(vault, collection, true))
	)
		throw new Error(i18n.t("sidebar:writing.cloudUnsafePath"));
	const ticket = await issueCloudTicket(project.id);
	const doc = await fetchDocument(ticket, project.id);
	const destination = joinVaultPath(collection, folder);
	let created = false;
	let registered = false;
	try {
		const snapshot = readWritingSnapshot(doc);
		const mainFile =
			snapshot.files.find((file) => file.id === snapshot.mainFileId)?.path ??
			"main.tex";
		const manifest = {
			schemaVersion: 1,
			projectId: project.id,
			name: project.name,
			mainFile,
			compiler: snapshot.compiler,
		} satisfies WritingManifest;
		await createWritingDirectory(destination);
		created = true;
		await saveCheckout(
			vault,
			project.id,
			ticket.role,
			doc,
			snapshotProjection(doc),
			manifest,
		);
		registered = true;
		for (const file of snapshot.files) {
			if (file.kind === "directory")
				await ensureWritingDirectory(destination, file.path);
			else if (file.kind === "text")
				await writeProjection(
					destination,
					file.path,
					new TextEncoder().encode(file.text ?? ""),
				);
			else if (file.asset)
				await writeProjection(
					destination,
					file.path,
					await fetchAsset(ticket, project.id, file.asset),
				);
		}
		await writeWritingManifest(destination, manifest);
		await refreshTree(vault);
		announceCheckoutChange();
		return joinVaultPath(destination, mainFile);
	} catch (error) {
		if (created) await remove(destination, { recursive: true }).catch(() => {});
		if (registered) await removeCheckout(vault, project.id);
		throw error;
	} finally {
		doc.destroy();
	}
}
