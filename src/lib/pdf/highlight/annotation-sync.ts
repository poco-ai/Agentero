import type {
	AnnotationEvent,
	AnnotationScope,
	AnnotationTransferItem,
} from "@embedpdf/plugin-annotation";
import { isLiveAnnotation } from "@/lib/pdf/highlight/annotation-store";
import { normalizePathKey } from "@/lib/vault/path";

type Mutation = Exclude<AnnotationEvent, { type: "loaded" }>;
type Peer = { documentId: string; receive: (event: Mutation) => void };
const groups = new Map<
	string,
	{ peers: Set<Peer>; latest: Map<string, Mutation> }
>();
const saves = new Map<string, Promise<void>>();
export function mergeAnnotationSnapshot(
	snapshot: AnnotationTransferItem[],
	disk: AnnotationTransferItem[],
	knownIds: ReadonlySet<string>,
	editedIds: ReadonlySet<string>,
): AnnotationTransferItem[] {
	const byId = new Map(disk.map((item) => [item.annotation.id, item]));
	const preserved = snapshot.flatMap((item) => {
		const id = item.annotation.id;
		if (editedIds.has(id) || !knownIds.has(id)) return [item];
		const latest = byId.get(id);
		return latest ? [latest] : [];
	});
	const savedIds = new Set(preserved.map((item) => item.annotation.id));
	return preserved.concat(
		disk.filter(
			(item) =>
				!editedIds.has(item.annotation.id) && !savedIds.has(item.annotation.id),
		),
	);
}

/** Mirror user edits between independent PDF engines, without watcher echo or re-saving imports. */
export function subscribeAnnotationPeer(
	paperPath: string,
	documentId: string,
	receive: Peer["receive"],
): () => void {
	const key = normalizePathKey(paperPath);
	let group = groups.get(key);
	if (!group) {
		group = { peers: new Set(), latest: new Map() };
		groups.set(key, group);
	}
	const peer = { documentId, receive };
	group.peers.add(peer);
	// A new embed can open before the writer's debounced sidecar save finishes.
	for (const event of group.latest.values()) receive(event);
	return () => {
		group.peers.delete(peer);
		if (!group.peers.size) groups.delete(key);
	};
}

export function publishAnnotationMutation(
	paperPath: string,
	event: AnnotationEvent,
): void {
	if (event.type === "loaded" || event.committed) return;
	const group = groups.get(normalizePathKey(paperPath));
	if (!group) return;
	group.latest.set(event.annotation.id, event);
	for (const peer of group.peers) {
		if (peer.documentId !== event.documentId) peer.receive(event);
	}
}

export function applyAnnotationMutation(
	scope: AnnotationScope,
	event: Mutation,
): void {
	const current = scope.getAnnotationById(event.annotation.id);
	const live = current && isLiveAnnotation(current);
	if (event.type === "delete") {
		if (live) scope.deleteAnnotation(event.pageIndex, event.annotation.id);
	} else if (event.type === "update" && live) {
		scope.updateAnnotation(event.pageIndex, event.annotation.id, event.patch);
	} else if (!live) {
		scope.createAnnotation(
			event.pageIndex,
			event.annotation,
			event.type === "create" ? event.ctx : undefined,
		);
		if (event.type === "update")
			scope.updateAnnotation(event.pageIndex, event.annotation.id, event.patch);
	}
}

/** Save snapshots in request order, even when an earlier export takes longer. */
export async function enqueueAnnotationSave(
	paperPath: string,
	save: () => Promise<void>,
): Promise<void> {
	const key = normalizePathKey(paperPath);
	const next = (saves.get(key) ?? Promise.resolve()).catch(() => {}).then(save);
	saves.set(key, next);
	try {
		await next;
	} finally {
		if (saves.get(key) === next) saves.delete(key);
	}
}
