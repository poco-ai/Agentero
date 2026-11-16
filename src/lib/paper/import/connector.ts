/**
 * Zotero Connector–compatible local server control (Host :23119).
 * @see docs/backend/connector.md
 */

import {
	type ConnectorProgress,
	type ConnectorStatus,
	commands,
} from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

/** Wire shapes from the generated bindings (also the event payloads). */
export type { ConnectorProgress, ConnectorStatus };

export async function connectorGetStatus(): Promise<ConnectorStatus> {
	if (!isTauri()) {
		return {
			enabled: false,
			listening: false,
			port: 23119,
			boundAddress: null,
			lastError: null,
			lastErrorCode: null,
			vaultPath: null,
			parentDir: "papers",
		};
	}
	return callApi(() => commands.connectorGetStatus());
}

export async function connectorSetEnabled(
	enabled: boolean,
): Promise<ConnectorStatus> {
	if (!isTauri()) {
		return connectorGetStatus();
	}
	return callApiResult(() => commands.connectorSetEnabled({ enabled }));
}

export async function connectorSetPort(port: number): Promise<ConnectorStatus> {
	if (!isTauri()) return connectorGetStatus();
	return callApiResult(() => commands.connectorSetPort({ port }));
}

export async function connectorSetVault(
	vaultPath: string | null,
): Promise<void> {
	if (!isTauri()) return;
	await callApi(() => commands.connectorSetVault({ vaultPath }));
}

/** Default save parent for Connector (`papers` or `papers/…` org folder). */
export async function connectorSetParentDir(parentDir: string): Promise<void> {
	if (!isTauri()) return;
	const dir = parentDir
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!dir) return;
	await callApi(() => commands.connectorSetParentDir({ parentDir: dir }));
}
