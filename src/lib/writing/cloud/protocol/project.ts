import * as Y from "yjs";
import { z } from "zod";
import {
	type CompilerEngine,
	compilerEngine,
	maxProjectFiles,
	validWritingName,
	type WritingImport,
	writingId,
	writingPath,
} from "./contracts.js";

export type WritingNode = {
	id: string;
	kind: "text" | "directory" | "asset";
	name: string;
	parentId: string | null;
	deleted?: boolean;
};

const nodeSchema = z
	.object({
		kind: z.enum(["text", "directory", "asset"]),
		name: z.string().refine(validWritingName),
		parentId: writingId.nullable(),
		deleted: z.boolean().optional(),
	})
	.strict();

const assetRefSchema = z
	.object({
		assetVersionId: writingId,
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export type AssetReference = z.infer<typeof assetRefSchema>;

export const projectFiles = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("files");
export const projectTexts = (doc: Y.Doc) => doc.getMap<Y.Text>("texts");
export const projectAssets = (doc: Y.Doc) =>
	doc.getMap<AssetReference>("assetRefs");
export const projectSettings = (doc: Y.Doc) =>
	doc.getMap<unknown>("compileSettings");

export function createWritingNode(
	doc: Y.Doc,
	node: Omit<WritingNode, "id">,
	text = "",
) {
	const id = crypto.randomUUID();
	doc.transact(() => {
		const meta = new Y.Map<unknown>();
		for (const [key, value] of Object.entries(nodeSchema.parse(node)))
			meta.set(key, value);
		projectFiles(doc).set(id, meta);
		if (node.kind === "text") {
			const sharedText = new Y.Text();
			projectTexts(doc).set(id, sharedText);
			if (text) sharedText.insert(0, text);
		}
	});
	return id;
}

export function getWritingText(doc: Y.Doc, fileId: string) {
	const text = projectTexts(doc).get(fileId);
	if (!(text instanceof Y.Text)) throw new Error("Text file missing");
	return text;
}

export type WritingSnapshotFile = WritingNode & {
	path: string;
	text?: string;
	asset?: AssetReference;
};

export type WritingSnapshot = {
	files: WritingSnapshotFile[];
	mainFileId: string | null;
	compiler: CompilerEngine;
};

function nameKey(value: string) {
	return value.normalize("NFC").toLowerCase();
}

function conflictName(name: string, id: string, suffix: number) {
	const extensionIndex = name.lastIndexOf(".");
	const tail =
		extensionIndex > 0 ? name.slice(extensionIndex, extensionIndex + 24) : "";
	const base = tail ? name.slice(0, extensionIndex) : name;
	const tag = `-conflict-${id.slice(0, 8)}${suffix ? `-${suffix}` : ""}`;
	return `${base.slice(0, 200 - tag.length - tail.length)}${tag}${tail}`;
}

/** Stable file IDs retain tombstones. Invalid parent chains become root entries. */
export function readWritingSnapshot(doc: Y.Doc): WritingSnapshot {
	const metadata = projectFiles(doc);
	const texts = projectTexts(doc);
	const assets = projectAssets(doc);
	const settings = projectSettings(doc);
	if (
		metadata.size > maxProjectFiles ||
		texts.size > maxProjectFiles ||
		assets.size > maxProjectFiles
	)
		throw new Error("Project file limit exceeded");

	const nodes = new Map<string, WritingNode>();
	for (const [id, meta] of metadata) {
		if (writingId.parse(id) !== id) throw new Error("Invalid file ID");
		if (!(meta instanceof Y.Map)) throw new Error("Invalid file metadata");
		nodes.set(id, { id, ...nodeSchema.parse(Object.fromEntries(meta)) });
	}
	for (const [id, text] of texts) {
		if (writingId.parse(id) !== id) throw new Error("Invalid file ID");
		if (
			!(text instanceof Y.Text) ||
			(nodes.get(id) && nodes.get(id)?.kind !== "text")
		)
			throw new Error("Invalid project text");
		if (
			text
				.toDelta()
				.some((part: { insert: unknown }) => typeof part.insert !== "string")
		)
			throw new Error("Project text must be plain text");
	}
	for (const [id, asset] of assets) {
		if (writingId.parse(id) !== id) throw new Error("Invalid file ID");
		assetRefSchema.parse(asset);
		if (nodes.get(id) && nodes.get(id)?.kind !== "asset")
			throw new Error("Invalid project asset");
	}
	for (const key of settings.keys())
		if (key !== "mainFileId" && key !== "compiler")
			throw new Error("Unknown compiler setting");

	const compiler = compilerEngine.parse(settings.get("compiler") ?? "xelatex");
	const mainFileId = writingId
		.nullable()
		.parse(settings.get("mainFileId") ?? null);
	const resolved = new Map<string, string>();
	const used = new Set<string>();
	const files: WritingSnapshotFile[] = [];

	const hidden = (node: WritingNode) => {
		const seen = new Set<string>();
		let current: WritingNode | undefined = node;
		while (current && !seen.has(current.id)) {
			if (current.deleted) return true;
			seen.add(current.id);
			const parent: WritingNode | undefined = current.parentId
				? nodes.get(current.parentId)
				: undefined;
			current = parent?.kind === "directory" ? parent : undefined;
		}
		return false;
	};

	const add = (
		node: WritingNode,
		visiting = new Set<string>(),
	): string | null => {
		if (hidden(node)) return null;
		const known = resolved.get(node.id);
		if (known) return known;
		if (visiting.has(node.id) || visiting.size >= 63) return null;
		visiting.add(node.id);
		const parent = node.parentId ? nodes.get(node.parentId) : undefined;
		// A deleted directory hides its descendants until restored.
		const parentPath =
			parent?.kind === "directory" ? add(parent, visiting) : null;
		visiting.delete(node.id);
		const prefix = parentPath ? `${parentPath}/` : "";
		let path = prefix + node.name;
		let attempt = 0;
		while (used.has(nameKey(path)))
			path = prefix + conflictName(node.name, node.id, attempt++);
		if (path.length > 1024) {
			path = node.name;
			while (used.has(nameKey(path)))
				path = conflictName(node.name, node.id, attempt++);
		}
		used.add(nameKey(path));
		resolved.set(node.id, path);
		files.push({
			...node,
			path,
			...(node.kind === "text"
				? { text: texts.get(node.id)?.toString() ?? "" }
				: {}),
			...(node.kind === "asset" ? { asset: assets.get(node.id) } : {}),
		});
		return path;
	};

	for (const id of [...nodes.keys()].sort()) {
		const node = nodes.get(id);
		if (node) add(node);
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { files, mainFileId, compiler };
}

export function createWritingDocument(input: WritingImport) {
	const doc = new Y.Doc();
	try {
		const byPath = new Map<string, string>();
		const imported = new Map(
			input.files.map((file) => [nameKey(file.path), file]),
		);
		if (imported.size !== input.files.length)
			throw new Error("Duplicate project path");
		const directoryId = (path: string): string | null => {
			if (!path) return null;
			const source = imported.get(nameKey(path));
			if (source && (source.kind !== "directory" || source.path !== path))
				throw new Error("Project file occupies a directory path");
			const existing = byPath.get(path);
			if (existing) return existing;
			const slash = path.lastIndexOf("/");
			const id = createWritingNode(doc, {
				kind: "directory",
				parentId: directoryId(slash < 0 ? "" : path.slice(0, slash)),
				name: path.slice(slash + 1),
			});
			byPath.set(path, id);
			return id;
		};
		doc.transact(() => {
			for (const file of input.files) {
				writingPath.parse(file.path);
				if (file.kind === "directory") {
					directoryId(file.path);
					continue;
				}
				const slash = file.path.lastIndexOf("/");
				const id = createWritingNode(
					doc,
					{
						kind: file.kind,
						parentId: directoryId(slash < 0 ? "" : file.path.slice(0, slash)),
						name: file.path.slice(slash + 1),
					},
					file.kind === "text" ? file.text : "",
				);
				byPath.set(file.path, id);
				if (file.kind === "asset")
					projectAssets(doc).set(id, {
						assetVersionId: file.assetVersionId,
						sha256: file.sha256,
					});
			}
			const mainFileId = input.mainFile ? byPath.get(input.mainFile) : null;
			if (
				input.mainFile &&
				(!mainFileId ||
					!input.mainFile.toLowerCase().endsWith(".tex") ||
					!projectTexts(doc).has(mainFileId))
			)
				throw new Error("Main file must be a TeX text file in the project");
			projectSettings(doc).set("mainFileId", mainFileId ?? null);
			projectSettings(doc).set("compiler", input.compiler);
		});
		const snapshot = readWritingSnapshot(doc);
		if (snapshot.files.some((file) => !byPath.has(file.path)))
			throw new Error("Conflicting project paths");
		return doc;
	} catch (error) {
		doc.destroy();
		throw error;
	}
}

export function hasPendingWritingDependencies(doc: Y.Doc) {
	return doc.store.pendingStructs != null || doc.store.pendingDs != null;
}
