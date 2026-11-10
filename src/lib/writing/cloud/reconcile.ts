import { readFile, remove } from "@tauri-apps/plugin-fs";
import type * as Y from "yjs";
import { joinVaultPath } from "@/lib/vault/path";
import {
	assertWritingDiskFile,
	type DiskFile,
	ensureWritingDirectory,
	recoveryDirectory,
	sameDiskFile,
	sha256,
	writeProjection,
} from "./disk";
import {
	type AssetReference,
	createWritingNode,
	getWritingText,
	projectAssets,
	projectFiles,
	readWritingSnapshot,
	type WritingSnapshotFile,
} from "./protocol/project";

export type Projection = Record<string, DiskFile>;

const utf8 = new TextEncoder();

export function diskVersion(file: WritingSnapshotFile): DiskFile {
	if (file.kind === "text")
		return { path: file.path, kind: "text", text: file.text ?? "" };
	if (file.kind === "asset") {
		if (!file.asset) throw new Error("Unresolved attachment version");
		return { path: file.path, kind: "asset", sha256: file.asset.sha256 };
	}
	return { path: file.path, kind: "directory" };
}

export function snapshotProjection(document: Y.Doc): Projection {
	return Object.fromEntries(
		readWritingSnapshot(document).files.map((file) => [
			file.id,
			diskVersion(file),
		]),
	);
}

function textChange(base: string, next: string) {
	let from = 0;
	while (from < base.length && from < next.length && base[from] === next[from])
		from++;
	let to = base.length;
	let end = next.length;
	while (to > from && end > from && base[to - 1] === next[end - 1]) {
		to--;
		end--;
	}
	return { from, to, insert: next.slice(from, end) };
}

export function mergeDiskText(base: string, disk: string, shared: string) {
	if (base === shared || disk === shared) return disk;
	if (disk === base) return shared;
	const local = textChange(base, disk);
	const remote = textChange(base, shared);
	if (local.from === remote.from) return null;
	if (local.to <= remote.from)
		return shared.slice(0, local.from) + local.insert + shared.slice(local.to);
	if (remote.to <= local.from) {
		const shift = remote.insert.length - (remote.to - remote.from);
		return (
			shared.slice(0, local.from + shift) +
			local.insert +
			shared.slice(local.to + shift)
		);
	}
	return null;
}

export function patchSharedText(text: Y.Text, value: string) {
	const before = text.toString();
	if (before === value) return;
	const { from, to, insert } = textChange(before, value);
	text.delete(from, to - from);
	if (insert) text.insert(from, insert);
}

type FilePlan = {
	path: string;
	file: DiskFile;
	id?: string;
	asset?: AssetReference;
};

type ReconcileOptions = {
	root: string;
	doc: Y.Doc;
	baseline: Projection;
	disk: Map<string, DiskFile>;
	canEdit: boolean;
	isCurrent: () => boolean;
	upload: (bytes: Uint8Array) => Promise<AssetReference>;
	download: (asset: AssetReference) => Promise<Uint8Array>;
	onConflicts: () => void;
};

function parentPath(path: string) {
	return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function depth(path: string) {
	return path.split("/").length;
}

async function readDiskBytes(root: string, file: DiskFile) {
	return file.kind === "text"
		? utf8.encode(file.text)
		: readFile(joinVaultPath(root, file.path));
}

async function preserveConflict(root: string, file: DiskFile) {
	if (file.kind === "directory") return;
	const bytes = await readDiskBytes(root, file);
	const hash = await sha256(bytes);
	await writeProjection(
		root,
		`${recoveryDirectory}/${hash.slice(0, 12)}/${file.path}`,
		bytes,
	);
}

export async function reconcileWritingCheckout(
	options: ReconcileOptions,
): Promise<Projection | null> {
	const { root, doc, baseline, disk, canEdit, upload, download, isCurrent } =
		options;
	const snapshot = readWritingSnapshot(doc);
	const sharedById = new Map(snapshot.files.map((file) => [file.id, file]));
	const sharedByPath = new Map(snapshot.files.map((file) => [file.path, file]));
	const knownPaths = new Set(Object.values(baseline).map((file) => file.path));
	const plans: FilePlan[] = [];
	const deleted = new Set<string>();
	const recovery = new Map<string, DiskFile>();

	// Previously projected paths are where an external editor can diverge.
	for (const [id, before] of Object.entries(baseline)) {
		const local = disk.get(before.path);
		const sharedNode = sharedById.get(id);
		const shared = sharedNode && diskVersion(sharedNode);
		if (
			sameDiskFile(local, before) ||
			(shared?.path === before.path && sameDiskFile(shared, local))
		)
			continue;
		if (!canEdit) {
			if (local) recovery.set(local.path, local);
			continue;
		}
		if (!local) {
			if (
				!shared ||
				shared.path !== before.path ||
				!sameDiskFile(before, shared)
			)
				continue;
			deleted.add(id);
			continue;
		}
		if (!shared || shared.path !== before.path || local.kind !== shared.kind) {
			recovery.set(local.path, local);
			continue;
		}
		if (
			local.kind === "text" &&
			before.kind === "text" &&
			shared.kind === "text"
		) {
			const text = mergeDiskText(before.text, local.text, shared.text);
			if (text == null) recovery.set(local.path, local);
			else plans.push({ id, path: shared.path, file: { ...local, text } });
		} else if (sameDiskFile(before, shared)) {
			plans.push({ id, path: shared.path, file: local });
		} else {
			recovery.set(local.path, local);
		}
	}

	for (const [path, local] of disk) {
		if (knownPaths.has(path)) continue;
		const shared = sharedByPath.get(path);
		if (shared && sameDiskFile(diskVersion(shared), local)) continue;
		if (
			!canEdit ||
			shared ||
			(knownPaths.has(parentPath(path)) && !sharedByPath.has(parentPath(path)))
		) {
			recovery.set(path, local);
			continue;
		}
		const matching = [...deleted].filter((id) => {
			const former = baseline[id];
			return former?.kind !== "directory" && sameDiskFile(former, local);
		});
		const renameId = matching.length === 1 && matching[0];
		if (renameId) {
			deleted.delete(renameId);
			plans.push({
				id: renameId,
				path,
				file: local,
				asset: sharedById.get(renameId)?.asset,
			});
		} else {
			plans.push({ path, file: local });
		}
	}

	for (const plan of plans) {
		if (plan.file.kind === "asset" && !plan.asset) {
			const bytes = await readDiskBytes(root, plan.file);
			if ((await sha256(bytes)) !== plan.file.sha256) return null;
			plan.asset = await upload(bytes);
		}
	}
	if (!isCurrent()) return null;

	if (plans.length || deleted.size) {
		const paths = new Map(
			snapshot.files
				.filter((file) => !deleted.has(file.id))
				.map((file) => [file.path, file.id]),
		);
		doc.transact(() => {
			for (const id of deleted) projectFiles(doc).get(id)?.set("deleted", true);
			for (const plan of plans.sort((a, b) => depth(a.path) - depth(b.path))) {
				const parent = parentPath(plan.path);
				const parentId = parent ? paths.get(parent) : null;
				if (parent && !parentId) continue;
				const name = plan.path.slice(parent.length ? parent.length + 1 : 0);
				const id =
					plan.id ??
					createWritingNode(
						doc,
						{ parentId: parentId ?? null, name, kind: plan.file.kind },
						plan.file.kind === "text" ? plan.file.text : "",
					);
				const node = projectFiles(doc).get(id);
				if (!node) continue;
				if (plan.id) {
					node.set("parentId", parentId ?? null);
					node.set("name", name);
					if (plan.file.kind === "text")
						patchSharedText(getWritingText(doc, id), plan.file.text);
				}
				paths.set(plan.path, id);
				if (plan.asset) projectAssets(doc).set(id, plan.asset);
			}
		}, "disk");
		return null;
	}

	for (const file of recovery.values()) await preserveConflict(root, file);
	if (recovery.size) options.onConflicts();

	const projected = new Set(snapshot.files.map((file) => file.path));
	const obsolete = [...Object.values(baseline), ...recovery.values()]
		.filter((file) => !projected.has(file.path) && disk.has(file.path))
		.sort((a, b) => depth(b.path) - depth(a.path));
	// Never remove a populated directory. Build products and ignored files can
	// remain locally even after their shared directory was tombstoned.
	for (const file of obsolete) {
		const path = joinVaultPath(root, file.path);
		await assertWritingDiskFile(root, file.path, disk.get(file.path) ?? null);
		await remove(path).catch((error) => {
			if (file.kind !== "directory") throw error;
		});
		disk.delete(file.path);
	}
	for (const file of snapshot.files.sort(
		(a, b) => depth(a.path) - depth(b.path),
	)) {
		if (sameDiskFile(disk.get(file.path), diskVersion(file))) continue;
		if (!isCurrent()) return null;
		if (file.kind === "directory")
			await ensureWritingDirectory(root, file.path);
		else if (file.kind === "text")
			await writeProjection(
				root,
				file.path,
				utf8.encode(file.text ?? ""),
				disk.get(file.path) ?? null,
			);
		else if (file.asset) {
			const bytes = await download(file.asset);
			if ((await sha256(bytes)) !== file.asset.sha256)
				throw new Error("Attachment integrity check failed");
			if (!isCurrent()) return null;
			await writeProjection(
				root,
				file.path,
				bytes,
				disk.get(file.path) ?? null,
			);
		}
	}
	return snapshotProjection(doc);
}
