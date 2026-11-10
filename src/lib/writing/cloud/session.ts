import { onAuthenticated, onSignedOut } from "tauri-plugin-better-auth/client";
import { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import i18n from "@/i18n";
import { events } from "@/lib/core/bindings";
import { normalizePath } from "@/lib/core/path";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { invalidateTexProjectIndex } from "@/lib/tex/project-index";
import { refreshTree } from "@/lib/vault/store";
import {
	type ExplicitWritingProject,
	explicitWritingProjectForPath,
	validateWritingProjectForSharing,
	writeWritingManifest,
} from "../project-manifest";
import { issueCloudTicket, uploadWritingAsset, WritingApiError } from "./api";
import {
	fetchAsset,
	type LocalCheckout,
	type ProjectBuildSettings,
	readCheckout,
	removeCheckout,
	restoreCheckout,
	saveCheckout,
} from "./checkout";
import { type DiskCache, scanWritingDisk } from "./disk";
import type { WritingRole, WritingSessionTicket } from "./protocol/contracts";
import {
	getWritingText,
	projectFiles,
	projectSettings,
	readWritingSnapshot,
} from "./protocol/project";
import { connectWritingSession } from "./protocol/session";
import { type Projection, reconcileWritingCheckout } from "./reconcile";

type Status =
	| "connecting"
	| "offline"
	| "saving"
	| "saved"
	| "denied"
	| "error";
type SessionState = {
	status: Status;
	role: WritingRole;
	revision: number;
	conflict: boolean;
};
type Peer = ReturnType<typeof connectWritingSession>;

export class WritingCheckoutSession {
	readonly document: Y.Doc;
	readonly awareness: Awareness;
	private project: ExplicitWritingProject;
	private projection: Projection;
	private manifest: ProjectBuildSettings;
	private peer: Peer | null = null;
	private ticket: WritingSessionTicket | null = null;
	private state: SessionState;
	private readonly listeners = new Set<() => void>();
	private readonly diskCache: DiskCache = new Map();
	private serial = Promise.resolve<boolean>(true);
	private persistence = Promise.resolve();
	private persistQueued = false;
	private fileIndex: Map<string, string> | null = null;
	private dirtyRevision = 0;
	private connected = false;
	private closed = false;
	private recovering = false;
	private signedOut = false;
	private readonly stopAuth: Array<Promise<() => void>>;
	private projectionReady = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private confirmTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly stopWatch: () => void;

	constructor(
		readonly vault: string,
		project: ExplicitWritingProject,
		checkout: LocalCheckout,
		readonly release: () => void,
	) {
		this.project = project;
		this.projection = checkout.projection;
		this.manifest = checkout.manifest ?? project.manifest;
		this.document = restoreCheckout(checkout);
		this.awareness = new Awareness(this.document);
		this.state = {
			status: "connecting",
			role: checkout.role,
			revision: 0,
			conflict: false,
		};
		this.document.on("update", this.onUpdate);
		projectFiles(this.document).observeDeep(this.invalidateFileIndex);
		this.stopWatch = listenEventSafe(events.vaultFileChanged, (payload) => {
			const root = normalizePath(this.project.directory);
			if (
				!payload.paths.some((path) => {
					const normalized = normalizePath(path);
					return normalized === root || normalized.startsWith(`${root}/`);
				})
			)
				return;
			this.dirtyRevision++;
			this.scheduleProjection(150);
		});
		// Restore and reconcile external changes before the first connection.
		void this.flush().finally(() => {
			if (!this.closed) void this.connect();
		});
		window.addEventListener("online", this.onOnline);
		this.stopAuth = [
			onSignedOut(() => {
				this.signedOut = true;
				this.connected = false;
				this.ticket = null;
				this.peer?.provider.disconnect();
				this.patch({ status: "denied" });
			}),
			onAuthenticated(() => {
				this.signedOut = false;
				if (this.peer) {
					void this.accessTicket()
						.then((ticket) => {
							if (!this.peer || this.signedOut || this.closed) return;
							this.peer.replaceTicket(ticket);
							this.patch({ role: ticket.role, status: "connecting" });
							return this.peer.provider.connect();
						})
						.catch(() => this.patch({ status: "denied" }));
				} else void this.connect();
			}),
		];
	}
	get projectId() {
		return this.project.manifest.projectId;
	}
	get rootDirectory() {
		return this.project.directory;
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private patch(patch: Partial<SessionState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	private invalidateFileIndex = () => {
		this.fileIndex = null;
	};
	textAt(relative: string) {
		this.fileIndex ??= new Map(
			readWritingSnapshot(this.document)
				.files.filter((file) => file.kind === "text")
				.map((file) => [file.path, file.id]),
		);
		const id = this.fileIndex.get(relative);
		return id ? getWritingText(this.document, id) : null;
	}
	async relocate(project: ExplicitWritingProject) {
		await this.serial;
		await validateWritingProjectForSharing(this.vault, project.directory);
		this.project = project;
		this.diskCache.clear();
		this.dirtyRevision++;
		this.scheduleProjection(0);
	}
	private onUpdate = () => {
		this.dirtyRevision++;
		this.queuePersistence();
		this.projectionReady = false;
		this.patch({
			revision: this.state.revision + 1,
			...(this.connected ? { status: "saving" as const } : {}),
		});
		this.scheduleProjection(90);
		this.scheduleConfirm();
	};
	private onOnline = () => {
		if (!this.peer) void this.connect();
		this.scheduleProjection(0);
	};
	private scheduleProjection(delay: number) {
		if (this.closed) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), delay);
	}
	private scheduleConfirm() {
		if (!this.connected || this.closed) return;
		clearTimeout(this.confirmTimer);
		this.confirmTimer = setTimeout(() => void this.confirm(), 400);
	}
	private async confirm() {
		const peer = this.peer;
		if (!peer || !this.connected || this.closed) return;
		const revision = this.state.revision;
		try {
			await peer.checkpoint();
			if (
				this.state.revision === revision &&
				this.projectionReady &&
				this.connected &&
				!this.closed
			)
				this.patch({ status: "saved" });
		} catch (error) {
			if (error instanceof Error && error.message.includes("(409)"))
				this.scheduleConfirm();
			else if (this.connected && this.state.status !== "denied")
				this.patch({ status: "error" });
		}
	}
	async accessTicket() {
		if (this.ticket && this.ticket.expiresAt * 1000 > Date.now() + 30_000)
			return this.ticket;
		this.ticket = await issueCloudTicket(this.projectId);
		return this.ticket;
	}
	private async connect() {
		if (this.closed || this.peer || this.recovering || this.signedOut) return;
		this.recovering = true;
		try {
			const ticket = await this.accessTicket();
			if (this.closed || this.signedOut) return;
			this.patch({ role: ticket.role, status: "connecting" });
			this.peer = connectWritingSession({
				projectId: this.projectId,
				document: this.document,
				awareness: this.awareness,
				ticket,
				refreshTicket: async () => {
					const next = await issueCloudTicket(this.projectId);
					this.ticket = next;
					this.patch({ role: next.role });
					return next;
				},
				onStatus: (status) => {
					this.connected = status === "connected";
					if (this.state.status !== "denied") {
						this.patch({
							status: this.connected
								? "saving"
								: status === "connecting"
									? "connecting"
									: "offline",
						});
					}
					if (this.connected) {
						this.scheduleConfirm();
						this.scheduleProjection(0);
					}
				},
				onDurableAck: () => this.scheduleConfirm(),
				onClose: (code) => {
					if (code === 4403) {
						this.connected = false;
						this.ticket = null;
						this.patch({ status: "denied" });
					}
				},
				onAuthenticationFailed: () => {
					this.connected = false;
					this.ticket = null;
					this.patch({ status: "denied" });
				},
			});
		} catch (error) {
			const denied =
				error instanceof WritingApiError &&
				[401, 403, 404].includes(error.status);
			this.patch({ status: denied ? "denied" : "offline" });
			if (!denied && !this.closed) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = setTimeout(() => void this.connect(), 2500);
			}
		} finally {
			this.recovering = false;
		}
	}
	saveLocal = () => {
		const next = this.persistence
			.catch(() => {})
			.then(async () => {
				if (!this.closed)
					await saveCheckout(
						this.vault,
						this.projectId,
						this.state.role,
						this.document,
						this.projection,
						this.manifest,
					);
			});
		this.persistence = next;
		return next;
	};
	private queuePersistence() {
		if (this.persistQueued || this.closed) return;
		this.persistQueued = true;
		const revision = this.dirtyRevision;
		void this.saveLocal()
			.catch(() => {
				if (!this.closed) this.patch({ status: "error" });
			})
			.finally(() => {
				this.persistQueued = false;
				if (revision !== this.dirtyRevision) this.queuePersistence();
			});
	}
	private async projectFiles() {
		const revision = this.dirtyRevision;
		const project = await explicitWritingProjectForPath(
			this.vault,
			this.rootDirectory,
			true,
		);
		if (!project || project.manifest.projectId !== this.projectId) return false;
		this.project = project;
		const canEdit =
			this.state.role !== "viewer" && this.state.status !== "denied";
		const disk = await scanWritingDisk(project, this.diskCache);
		if (revision !== this.dirtyRevision) return false;
		await this.saveLocal();
		const updated = await reconcileWritingCheckout({
			root: this.rootDirectory,
			doc: this.document,
			baseline: this.projection,
			disk,
			canEdit,
			isCurrent: () => revision === this.dirtyRevision,
			upload: async (bytes) => {
				const { assetVersionId, sha256 } = await uploadWritingAsset(
					await this.accessTicket(),
					this.projectId,
					bytes,
				);
				return { assetVersionId, sha256 };
			},
			download: async (asset) =>
				fetchAsset(await this.accessTicket(), this.projectId, asset),
			onConflicts: () => this.patch({ conflict: true }),
		});
		if (!updated) return false;
		const snapshot = readWritingSnapshot(this.document);
		const main = snapshot.files.find((file) => file.id === snapshot.mainFileId);
		if (
			canEdit &&
			(project.manifest.mainFile !== this.manifest.mainFile ||
				project.manifest.compiler !== this.manifest.compiler)
		) {
			const proposed = snapshot.files.find(
				(file) =>
					file.path === project.manifest.mainFile && file.kind === "text",
			);
			const changedMain = project.manifest.mainFile !== this.manifest.mainFile;
			const changedEngine =
				project.manifest.compiler !== this.manifest.compiler;
			// Treat a changed manifest as an explicit local settings operation.
			if (
				(changedMain && proposed?.id !== snapshot.mainFileId) ||
				(changedEngine && project.manifest.compiler !== snapshot.compiler)
			) {
				this.manifest = project.manifest;
				this.document.transact(() => {
					if (changedMain && proposed)
						projectSettings(this.document).set("mainFileId", proposed.id);
					if (changedEngine)
						projectSettings(this.document).set(
							"compiler",
							project.manifest.compiler,
						);
				}, "disk");
			}
		} else if (
			main &&
			(project.manifest.mainFile !== main.path ||
				project.manifest.compiler !== snapshot.compiler)
		) {
			await writeWritingManifest(this.rootDirectory, {
				...project.manifest,
				mainFile: main.path,
				compiler: snapshot.compiler,
			});
			this.manifest = { mainFile: main.path, compiler: snapshot.compiler };
		}
		const changedTree =
			JSON.stringify(
				Object.values(this.projection)
					.map((file) => file.path)
					.sort(),
			) !==
			JSON.stringify(
				Object.values(updated)
					.map((file) => file.path)
					.sort(),
			);
		this.projection = updated;
		await this.saveLocal();
		this.projectionReady = revision === this.dirtyRevision;
		invalidateTexProjectIndex();
		if (changedTree) await refreshTree(this.vault);
		this.scheduleConfirm();
		return this.projectionReady;
	}
	flush = () => {
		clearTimeout(this.timer);
		const next = this.serial.then(async () => {
			if (this.closed) return false;
			try {
				return await this.projectFiles();
			} catch (error) {
				if (
					error instanceof WritingApiError &&
					[401, 403, 404].includes(error.status)
				)
					this.patch({ status: "denied" });
				else if (this.connected || !(error instanceof TypeError))
					this.patch({ status: "error" });
				return false;
			}
		});
		this.serial = next;
		return next;
	};
	async durableCheckpoint() {
		if (!(await this.flush()))
			throw new Error(i18n.t("sidebar:writing.cloudFileChanged"));
		if (!this.peer) throw new Error(i18n.t("sidebar:writing.cloudOffline"));
		return this.peer.checkpoint();
	}
	async detach() {
		if (!(await this.flush()) || !this.peer)
			throw new Error(i18n.t("sidebar:writing.cloudDetachPending"));
		await this.peer.checkpoint();
		await this.persistence;
		this.close();
		await removeCheckout(this.vault, this.projectId);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.timer);
		clearTimeout(this.confirmTimer);
		clearTimeout(this.reconnectTimer);
		window.removeEventListener("online", this.onOnline);
		this.stopWatch();
		for (const stop of this.stopAuth)
			void stop.then((unlisten) => unlisten()).catch(() => {});
		if (this.peer) this.peer.destroy();
		else this.awareness.destroy();
		this.document.off("update", this.onUpdate);
		projectFiles(this.document).unobserveDeep(this.invalidateFileIndex);
		this.document.destroy();
		this.release();
	}
}

const sessions = new Map<string, Promise<WritingCheckoutSession | null>>();
export async function openWritingCheckout(
	vault: string,
	project: ExplicitWritingProject,
) {
	const key = `${normalizePath(vault)}:${project.manifest.projectId}`;
	let result = sessions.get(key);
	if (result) {
		const session = await result;
		if (
			!session ||
			normalizePath(session.rootDirectory) === normalizePath(project.directory)
		)
			return session;
		await session.relocate(project);
		return session;
	}
	result = (async () => {
		const checkout = await readCheckout(vault, project.manifest.projectId);
		if (!checkout || checkout.bootstrapping) return null;
		await validateWritingProjectForSharing(vault, project.directory);
		if (!navigator.locks)
			throw new Error(i18n.t("sidebar:writing.cloudWindowBusy"));
		return new Promise<WritingCheckoutSession>((resolve, reject) => {
			void navigator.locks
				.request(`agentero-writing:${key}`, { ifAvailable: true }, (lock) => {
					if (!lock) {
						reject(new Error(i18n.t("sidebar:writing.cloudWindowBusy")));
						return;
					}
					return new Promise<void>((release) => {
						const session = new WritingCheckoutSession(
							vault,
							project,
							checkout,
							() => {
								sessions.delete(key);
								release();
							},
						);
						resolve(session);
					});
				})
				.catch(reject);
		});
	})();
	sessions.set(key, result);
	try {
		const session = await result;
		if (!session) sessions.delete(key);
		return session;
	} catch (error) {
		sessions.delete(key);
		throw error;
	}
}

/** Finish local SQLite writes before the native window closes. */
export async function flushCloudCheckouts() {
	try {
		await Promise.all(
			[...sessions.values()].map(async (pending) =>
				(await pending)?.saveLocal(),
			),
		);
		return true;
	} catch {
		return false;
	}
}
