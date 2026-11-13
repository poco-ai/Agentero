/**
 * Vault cloud sync (S3-compatible / WebDAV) — Host command wrappers.
 * Design: docs/backend/sync.md
 */

import {
	commands,
	type SyncBackendConfig as SyncBackendConfigWire,
	type SyncStateEvent_Deserialize,
	type SyncStatus_Serialize,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

/**
 * Which bulky paper assets take part in sync. Notes, metadata sidecars,
 * marks and embedded images always sync — they are small and irreplaceable,
 * while PDFs / LaTeX sources can be re-fetched from their upstream source.
 */
export type SyncScope = {
	pdf: boolean;
	source: boolean;
	attachments: boolean;
};

/** Storage backend discriminator; legacy configs without one are S3. */
export type SyncBackendKind = "s3" | "webdav" | "git" | "agentero";

export type SyncBackendConfig = {
	backend: SyncBackendKind;
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKey: string;
	/** Masked (`***`) on the way out; send the mask back to keep the secret. */
	secretKey: string;
	forcePathStyle: boolean;
	/** WebDAV server directory, e.g. `https://dav.jianguoyun.com/dav/agentero/`. */
	webdavUrl: string;
	webdavUsername: string;
	/** Masked like the S3 secret key. */
	webdavPassword: string;
	/** Git remote URL or local path; credentials come from system Git. */
	gitRemote: string;
	/** Branch synced by the Git backend (default `main`). */
	gitBranch: string;
	/** Allow a non-loopback `http://` remote. The token travels in cleartext. */
	gitAllowInsecureHttp: boolean;
	/** `user` or `organization` for official cloud sync. */
	agenteroSubject: "user" | "organization";
	/** Organization id when `agenteroSubject` is `organization`. */
	agenteroOrgId: string;
	/** API origin. Empty until the host fills the signed-in origin. */
	agenteroApi: string;
	/** Background sync: on open, after 30s quiet, and every intervalMinutes. */
	autoSync: boolean;
	intervalMinutes: number;
	/** Detected on connect: false when the backend rejects conditional PUTs. */
	conditionalWrites: boolean;
	/** Sync scope for bulky paper assets (default: everything). */
	scope: SyncScope;
};

export type SyncStatus = {
	configured: boolean;
	config?: SyncBackendConfig;
	running: boolean;
	lastSyncAt?: string;
	lastVersion: number;
};

export type SyncOutcome = {
	version: number;
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	removedRemote: number;
	conflictCopies: string[];
};

/** `sync:state` payload comes straight from the generated wire contract. */
export type SyncStateEvent = SyncStateEvent_Deserialize;

/** `sync:progress` phases; the wire payload types `phase` as a plain string. */
export type SyncPhase = "scan" | "pull" | "download" | "upload" | "finalize";

export type SyncProgressEvent = {
	vaultPath: string;
	phase: SyncPhase;
	current: number;
	total: number;
};

const SYNC_PHASES: readonly string[] = [
	"scan",
	"pull",
	"download",
	"upload",
	"finalize",
];

export function isSyncProgressPhase(phase: string): phase is SyncPhase {
	return SYNC_PHASES.includes(phase);
}

export const emptySyncConfig = (
	backend: SyncBackendKind = "agentero",
): SyncBackendConfig => ({
	backend,
	endpoint: "",
	region: "us-east-1",
	bucket: "",
	prefix: "",
	accessKey: "",
	secretKey: "",
	forcePathStyle: true,
	webdavUrl: "",
	webdavUsername: "",
	webdavPassword: "",
	gitRemote: "",
	gitBranch: "main",
	gitAllowInsecureHttp: false,
	agenteroSubject: "user",
	agenteroOrgId: "",
	agenteroApi: "",
	autoSync: true,
	intervalMinutes: 30,
	conditionalWrites: true,
	scope: { pdf: true, source: true, attachments: true },
});

/** Interval choices shared with the Host (`config::INTERVAL_CHOICES`). */
export const SYNC_INTERVAL_CHOICES = [15, 30, 60];

/** Local disk usage per bulky-asset category (bytes). */
export type SyncScopeSizes = {
	pdf: number;
	source: number;
	attachments: number;
};

/** Fold the generated wire status into the local all-fields-present shape. */
function statusFromWire(status: SyncStatus_Serialize): SyncStatus {
	const config = status.config;
	return {
		configured: status.configured,
		config: config ? configFromWire(config) : undefined,
		running: status.running,
		lastSyncAt: status.lastSyncAt ?? undefined,
		lastVersion: status.lastVersion,
	};
}

function configFromWire(config: SyncBackendConfigWire): SyncBackendConfig {
	return {
		backend: (config.backend as SyncBackendKind | undefined) ?? "s3",
		endpoint: config.endpoint ?? "",
		region: config.region ?? "us-east-1",
		bucket: config.bucket ?? "",
		prefix: config.prefix ?? "",
		accessKey: config.accessKey ?? "",
		secretKey: config.secretKey ?? "",
		forcePathStyle: config.forcePathStyle ?? true,
		webdavUrl: config.webdavUrl ?? "",
		webdavUsername: config.webdavUsername ?? "",
		webdavPassword: config.webdavPassword ?? "",
		gitRemote: config.gitRemote ?? "",
		gitBranch: config.gitBranch ?? "main",
		gitAllowInsecureHttp: config.gitAllowInsecureHttp ?? false,
		agenteroSubject:
			config.agenteroSubject === "organization" ? "organization" : "user",
		agenteroOrgId: config.agenteroOrgId ?? "",
		agenteroApi: config.agenteroApi ?? "",
		autoSync: config.autoSync ?? true,
		intervalMinutes: config.intervalMinutes ?? 30,
		conditionalWrites: config.conditionalWrites ?? true,
		scope: {
			pdf: config.scope?.pdf ?? true,
			source: config.scope?.source ?? true,
			attachments: config.scope?.attachments ?? true,
		},
	};
}

export async function syncGetStatus(vaultPath: string): Promise<SyncStatus> {
	return statusFromWire(
		await callApiResult(() => commands.syncGetStatus({ vaultPath })),
	);
}

export function syncScopeSizes(vaultPath: string): Promise<SyncScopeSizes> {
	return callApiResult(() => commands.syncScopeSizes({ vaultPath }));
}

export async function syncConfigure(
	vaultPath: string,
	config: SyncBackendConfig,
): Promise<SyncStatus> {
	return statusFromWire(
		await callApiResult(() => commands.syncConfigure({ vaultPath, config })),
	);
}

export async function syncDisconnect(vaultPath: string): Promise<void> {
	await callApiResult(() => commands.syncDisconnect({ vaultPath }));
}

export function syncNow(vaultPath: string): Promise<SyncOutcome> {
	return callApiResult(() => commands.syncNow({ vaultPath }));
}

export type SyncCloudUsage = {
	signedIn: boolean;
	used: number;
	limit: number;
	tier: string;
	planKey: string;
};

export function syncCloudUsage(
	subject: "user" | "organization",
	orgId?: string,
): Promise<SyncCloudUsage> {
	return callApiResult(() =>
		commands.syncCloudUsage({ subject, orgId: orgId ?? null }),
	);
}
