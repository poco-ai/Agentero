import type { PluginRegistry } from "@embedpdf/core";
import type { AnnotationScope } from "@embedpdf/plugin-annotation";
import {
	type Command,
	type HistoryCapability,
	HistoryPlugin,
	HistoryPluginPackage,
	type HistoryScope,
} from "@embedpdf/plugin-history";

type AnnotationMetadata = { annotationIds?: string[] };

export interface PdfHistoryScope extends HistoryScope {
	/** Several annotation commands produced by one user gesture. */
	batch<T>(action: () => T): T;
	/** Imports, peer updates and internal deletion retries are not user edits. */
	withoutRecording<T>(action: () => T): T;
	invalidate(annotationIds: string[]): void;
}

export interface PdfHistoryCapability extends HistoryCapability {
	forDocument(documentId: string): PdfHistoryScope;
}

/** Extend the upstream command stack through its public capability interface. */
class PdfHistoryPlugin extends HistoryPlugin {
	private scopes = new Map<string, PdfHistoryScope>();

	protected buildCapability(): PdfHistoryCapability {
		const capability = super.buildCapability();
		return {
			...capability,
			forDocument: (documentId) => {
				const existing = this.scopes.get(documentId);
				if (existing) return existing;
				const upstream = capability.forDocument(documentId);
				let commands: Command<AnnotationMetadata>[] | null = null;
				let silent = 0;
				const scope: PdfHistoryScope = {
					...upstream,
					register(command, topic) {
						if (silent) command.execute();
						else if (commands && topic === "annotations") {
							commands.push(command as Command<AnnotationMetadata>);
							command.execute();
						} else upstream.register(command, topic);
					},
					batch(action) {
						if (commands || silent) return action();
						const group: Command<AnnotationMetadata>[] = [];
						commands = group;
						try {
							return action();
						} finally {
							commands = null;
							if (group.length) {
								// The gesture already executed while collecting its commands.
								let firstExecution = true;
								upstream.register(
									{
										execute() {
											if (firstExecution) firstExecution = false;
											else for (const command of group) command.execute();
										},
										undo() {
											for (const command of [...group].reverse())
												command.undo();
										},
										metadata: {
											annotationIds: [
												...new Set(
													group.flatMap(
														(command) => command.metadata?.annotationIds ?? [],
													),
												),
											],
										},
									},
									"annotations",
								);
							}
						}
					},
					withoutRecording(action) {
						silent++;
						try {
							return action();
						} finally {
							silent--;
						}
					},
					invalidate(annotationIds) {
						const ids = new Set(annotationIds);
						upstream.purgeByMetadata<AnnotationMetadata>(
							(metadata) =>
								metadata?.annotationIds?.some((id) => ids.has(id)) ?? false,
							"annotations",
						);
					},
				};
				this.scopes.set(documentId, scope);
				return scope;
			},
		};
	}

	protected onDocumentClosed(documentId: string): void {
		this.scopes.delete(documentId);
		super.onDocumentClosed(documentId);
	}

	async destroy(): Promise<void> {
		this.scopes.clear();
		await super.destroy();
	}
}

export const PdfHistoryPluginPackage = {
	...HistoryPluginPackage,
	create: (registry: PluginRegistry) =>
		new PdfHistoryPlugin("history", registry),
};

/** Serialize undo/redo with engine commits, including deletion-queue retries. */
export function createAnnotationHistoryReplay(
	annotations: AnnotationScope,
	history: PdfHistoryScope,
	onError: (error: unknown) => void,
) {
	let disposed = false;
	let pending = Promise.resolve();
	const cancelWaits = new Set<() => void>();
	const waitForCommit = () =>
		new Promise<boolean>((resolve, reject) => {
			let off = () => {};
			const finish = (ready: boolean) => {
				off();
				cancelWaits.delete(cancel);
				resolve(ready);
			};
			const cancel = () => finish(false);
			const check = () => {
				// Reducers notify before the plugin releases its commit lock and the
				// delete coordinator may reassert an intent in the same microtask turn.
				queueMicrotask(() => {
					if (disposed) finish(false);
					else if (!annotations.getState().hasPendingChanges) finish(true);
				});
			};
			cancelWaits.add(cancel);
			off = annotations.onStateChange(check);
			annotations.commit().wait(check, (error) => {
				off();
				cancelWaits.delete(cancel);
				reject(error);
			});
			check();
		});
	return {
		replay(redo: boolean) {
			pending = pending
				.then(async () => {
					if (disposed || !(await waitForCommit())) return;
					if (redo) history.redo();
					else history.undo();
					if (!disposed) await waitForCommit();
				})
				.catch(onError);
			return pending;
		},
		dispose() {
			disposed = true;
			for (const cancel of cancelWaits) cancel();
		},
	};
}
