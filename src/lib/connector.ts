/**
 * Zotero Connector–compatible local server control (Host :23119).
 * @see docs/backend/connector.md
 */
import { ipc } from "@/lib/ipc";
import { isTauri } from "@/lib/tauri";

export type ConnectorStatus = {
	enabled: boolean;
	listening: boolean;
	port: number;
	boundAddress: string | null;
	lastError: string | null;
	vaultPath: string | null;
	parentDir: string;
};

export type ConnectorItemSaved = {
	path: string;
	id: string;
	title: string;
	deduped: boolean;
	sessionId: string;
};

export type ConnectorProgress = {
	key: string;
	sessionId: string;
	path: string;
	title: string;
	status: "running" | "completed" | "failed";
	progress: number | null;
	detail: string | null;
	error: string | null;
};

export async function connectorGetStatus(): Promise<ConnectorStatus> {
	if (!isTauri()) {
		return {
			enabled: false,
			listening: false,
			port: 23119,
			boundAddress: null,
			lastError: null,
			vaultPath: null,
			parentDir: "papers",
		};
	}
	return ipc<ConnectorStatus>("connector_get_status");
}

export async function connectorSetEnabled(
	enabled: boolean,
): Promise<ConnectorStatus> {
	if (!isTauri()) {
		return connectorGetStatus();
	}
	return ipc<ConnectorStatus>("connector_set_enabled", { args: { enabled } });
}

export async function connectorSetPort(port: number): Promise<ConnectorStatus> {
	if (!isTauri()) return connectorGetStatus();
	return ipc<ConnectorStatus>("connector_set_port", { args: { port } });
}

export async function connectorSetVault(
	vaultPath: string | null,
): Promise<void> {
	if (!isTauri()) return;
	await ipc("connector_set_vault", { args: { vaultPath } });
}

/** Default save parent for Connector (`papers` or `papers/…` org folder). */
export async function connectorSetParentDir(parentDir: string): Promise<void> {
	if (!isTauri()) return;
	const dir = parentDir
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!dir) return;
	await ipc("connector_set_parent_dir", { args: { parentDir: dir } });
}
