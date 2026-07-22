import { remoteList, remoteSessionIdFromHandle } from "@/lib/remote-vault";
import {
	type FileNode,
	isEagerTreeRel,
	joinRemotePath,
	shouldIgnoreTreeName,
	sortNodes,
} from "@/lib/vault/types";

/** Build directory children over SFTP. Mirrors {@link buildTreeLocal}. */
export async function buildTreeRemote(
	handle: string,
	rel: string,
	depth = 0,
	shallowOnly = false,
): Promise<FileNode[]> {
	if (depth > 12) return [];
	const sessionId = remoteSessionIdFromHandle(handle);
	if (!sessionId) return [];

	const entries = await remoteList(sessionId, rel);
	const nodes: FileNode[] = [];

	for (const entry of entries) {
		if (!entry.name || shouldIgnoreTreeName(entry.name)) continue;

		const childRel = entry.path;
		const path = joinRemotePath(handle, childRel);
		if (entry.isDir) {
			const node = await buildDirNodeRemote(
				handle,
				path,
				entry.name,
				childRel,
				depth,
				shallowOnly,
			);
			nodes.push(node);
		} else if (entry.isFile) {
			nodes.push({
				id: path,
				name: entry.name,
				path,
				kind: "file",
			});
		}
	}

	return sortNodes(nodes);
}

async function buildDirNodeRemote(
	handle: string,
	path: string,
	name: string,
	childRel: string,
	depth: number,
	shallowOnly: boolean,
): Promise<FileNode> {
	if (shallowOnly) {
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children: [],
			childrenPending: true,
		};
	}
	if (isEagerTreeRel(childRel)) {
		const children = await buildTreeRemote(handle, childRel, depth + 1, false);
		return {
			id: path,
			name,
			path,
			kind: "directory",
			children,
		};
	}
	const children = await buildTreeRemote(handle, childRel, depth + 1, true);
	return {
		id: path,
		name,
		path,
		kind: "directory",
		children,
		childrenPending: false,
	};
}
