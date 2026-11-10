import { useEffect, useState } from "react";
import { useStore } from "zustand";
import {
	useVaultStore,
	useWorkspaceStore,
	useWritingStore,
} from "@/hooks/use-app-stores";
import { vaultRelativePath } from "@/lib/vault/path";
import {
	type ExplicitWritingProject,
	explicitWritingProjectForPath,
	writingLibraryRelative,
} from "@/lib/writing/project-manifest";
import { writingHistoryProjectRel } from "@/lib/writing/session";
import { writingTreeStore } from "@/lib/writing/tree-target";

type ProjectLookup =
	| { status: "pending" }
	| { status: "error"; message: string }
	| { status: "ready"; project: ExplicitWritingProject | null };

const PENDING: ProjectLookup = { status: "pending" };
const EMPTY: ProjectLookup = { status: "ready", project: null };

export function useWritingProject(
	vault: string | null | undefined,
	path: string | null,
	directory = false,
): ProjectLookup {
	const rel = vault && path ? writingLibraryRelative(vault, path) : null;
	const tree = useVaultStore((state) => (rel ? state.tree : null));
	const revision = useStore(writingTreeStore, (state) => state.revision);
	const [lookup, setLookup] = useState<{
		key: string;
		result: ProjectLookup;
	}>();
	const key = rel ? `${vault}:${rel}:${revision}` : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh ownership when the filesystem tree changes.
	useEffect(() => {
		if (!key || !vault || !path) return;
		let cancelled = false;
		void explicitWritingProjectForPath(vault, path, directory).then(
			(project) => {
				if (!cancelled)
					setLookup({ key, result: { status: "ready", project } });
			},
			(error: unknown) => {
				if (!cancelled)
					setLookup({
						key,
						result: { status: "error", message: String(error) },
					});
			},
		);
		return () => {
			cancelled = true;
		};
	}, [key, vault, path, directory, tree]);
	if (!key) return EMPTY;
	return lookup?.key === key ? lookup.result : PENDING;
}

/** Resolve history and Git scope before offering operations that use it. */
export function useWritingProjectRelative(
	vault: string | null | undefined,
	path: string | null,
): string | null {
	const lookup = useWritingProject(vault, path);
	if (!vault || !path || lookup.status !== "ready") return null;
	return lookup.project
		? vaultRelativePath(vault, lookup.project.directory)
		: writingHistoryProjectRel(vault, path);
}

export function useActiveWritingRoot(): string | null {
	const workspaceRoot = useWorkspaceStore(
		(state) =>
			state.tabs.find((tab) => tab.id === state.activeTabId)?.writingRoot ??
			null,
	);
	const deskRoot = useWritingStore((state) => state.activeRoot);
	return workspaceRoot ?? deskRoot;
}
