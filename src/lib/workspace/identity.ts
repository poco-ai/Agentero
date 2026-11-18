import { vaultLoadGeneration as readVaultLoadGeneration } from "@/lib/vault/store";

/** Opaque view identity. Do not parse this as a file path. */
export type ViewId = string;

export type ResourceKey = string;

export type WindowLabel = string;

/** Active Vault load generation (`treeLoadGeneration` in the vault store). */
export function vaultLoadGeneration(): number {
	return readVaultLoadGeneration();
}
