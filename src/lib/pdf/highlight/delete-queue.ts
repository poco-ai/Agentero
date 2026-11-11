import type { AnnotationScope } from "@embedpdf/plugin-annotation";

type DeleteScope = Pick<
	AnnotationScope,
	"getState" | "deleteAnnotation" | "onStateChange"
>;

/**
 * v2 can clear a deletion's pending flag when an older operation on the same uid
 * settles (including engine failures, which emit no annotation event). Observe
 * the public document state, then reassert once after the reducer/commit lock
 * completes. A second failed settlement reports failure instead of polling.
 */
export function createAnnotationDeleteQueue(
	scope: DeleteScope,
	onError: (error?: unknown) => void,
	withoutRecording: (action: () => void) => void = (action) => action(),
) {
	const pending = new Map<string, { pageIndex: number; reasserted: boolean }>();
	let disposed = false;
	let scheduled = false;
	const check = () => {
		if (disposed || scheduled || pending.size === 0) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (disposed) return;
			for (const [id, request] of pending) {
				const state = scope.getState();
				if (state.byUid[id]?.commitState !== "deleted") {
					// Purged by a successful commit, or superseded by undo/new edits.
					pending.delete(id);
					continue;
				}
				if (state.hasPendingChanges) continue;
				if (request.reasserted) {
					pending.delete(id);
					onError();
					continue;
				}
				request.reasserted = true;
				try {
					withoutRecording(() => scope.deleteAnnotation(request.pageIndex, id));
				} catch (error) {
					pending.delete(id);
					onError(error);
				}
			}
		});
	};
	const off = scope.onStateChange(check);
	return {
		delete(pageIndex: number, id: string) {
			if (disposed) return;
			if (
				pending.has(id) &&
				scope.getState().byUid[id]?.commitState === "deleted"
			)
				return;
			pending.set(id, { pageIndex, reasserted: false });
			try {
				scope.deleteAnnotation(pageIndex, id);
				check();
			} catch (error) {
				pending.delete(id);
				onError(error);
			}
		},
		dispose() {
			disposed = true;
			pending.clear();
			off();
		},
	};
}
