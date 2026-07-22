//! Generic per-record sidecar store shared by PDF highlights, ask threads, and
//! translate records. All three persist one JSON file per id under a paper's
//! `marks/` dir (via `pdf-selection/marks-io`) and fall back to an in-memory
//! map in browser dev. They differ only in record `kind`, schema parser, sort
//! key, and whether `updatedAt` is re-stamped on every write.

import {
	deleteMarkFile,
	listMarkRaw,
	readMarkRaw,
	writeMarkFile,
} from "@/lib/pdf-selection/marks-io";
import { isTauri } from "@/lib/tauri";

/** Minimum shape every sidecar record shares. */
export interface SidecarRecord {
	id: string;
	kind: string;
	createdAt: string;
	updatedAt?: string;
}

export interface SidecarStore<T extends SidecarRecord> {
	list(paperAbsPath: string): Promise<T[]>;
	read(paperAbsPath: string, id: string): Promise<T | null>;
	write(paperAbsPath: string, record: T): Promise<void>;
	remove(paperAbsPath: string, id: string): Promise<void>;
}

export interface SidecarStoreOptions<T extends SidecarRecord> {
	/** Record discriminant, re-asserted on every write. */
	kind: T["kind"];
	/** Schema validator returning null on malformed input. */
	parse: (raw: unknown) => T | null;
	/** Field to sort by (descending) when listing. */
	sortKey: "createdAt" | "updatedAt";
	/**
	 * `"always"` re-stamps `updatedAt` on each write (ask threads, highlights);
	 * `"preserve"` keeps the record's own `updatedAt` when present (translates).
	 */
	stampUpdatedAt: "always" | "preserve";
}

export function makeSidecarStore<T extends SidecarRecord>(
	options: SidecarStoreOptions<T>,
): SidecarStore<T> {
	const { kind, parse, sortKey, stampUpdatedAt } = options;
	// In-memory fallback when not running under Tauri (browser dev).
	const memoryStore = new Map<string, Map<string, T>>();

	function bucket(paperAbsPath: string): Map<string, T> {
		let b = memoryStore.get(paperAbsPath);
		if (!b) {
			b = new Map();
			memoryStore.set(paperAbsPath, b);
		}
		return b;
	}

	const byKeyDesc = (a: T, b: T) =>
		(a[sortKey] ?? "") < (b[sortKey] ?? "") ? 1 : -1;

	return {
		async list(paperAbsPath) {
			if (!paperAbsPath) return [];
			if (!isTauri()) {
				return Array.from(bucket(paperAbsPath).values()).sort(byKeyDesc);
			}
			const out: T[] = [];
			for (const raw of await listMarkRaw(paperAbsPath)) {
				const parsed = parse(raw);
				if (parsed) out.push(parsed);
			}
			out.sort(byKeyDesc);
			return out;
		},

		async read(paperAbsPath, id) {
			if (!isTauri()) {
				return bucket(paperAbsPath).get(id) ?? null;
			}
			const raw = await readMarkRaw(paperAbsPath, id);
			return raw ? parse(raw) : null;
		},

		async write(paperAbsPath, record) {
			const now = new Date().toISOString();
			const next: T = {
				...record,
				kind,
				updatedAt:
					stampUpdatedAt === "always" ? now : (record.updatedAt ?? now),
			};
			if (!isTauri()) {
				bucket(paperAbsPath).set(next.id, next);
				return;
			}
			await writeMarkFile(paperAbsPath, next.id, next);
		},

		async remove(paperAbsPath, id) {
			if (!paperAbsPath || !id) return;
			if (!isTauri()) {
				bucket(paperAbsPath).delete(id);
				return;
			}
			await deleteMarkFile(paperAbsPath, id);
		},
	};
}
