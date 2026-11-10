import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { useVaultStore } from "@/hooks/use-app-stores";
import { texSettingsStore } from "@/lib/tex/config";
import { resolveTexRoot } from "@/lib/workspace/tex-compile";
import { useWritingProject } from "./use-writing-project";

/** Compile root for a TeX path, including a main file chosen in the file tree. */
export function useTexRoot(texPath: string | null): string | null {
	const vault = useVaultStore((state) => state.vaultPath);
	const project = useWritingProject(vault, texPath);
	const roots = useStore(texSettingsStore, (state) => state.roots);
	const [root, setRoot] = useState(texPath);

	useEffect(() => {
		if (!texPath) {
			setRoot(null);
			return;
		}
		if (project.status === "pending") return;
		if (project.status === "error") {
			setRoot(null);
			return;
		}
		const stamp = roots;
		let cancelled = false;
		void resolveTexRoot(texPath)
			.then((next) => {
				if (!cancelled && stamp === roots) setRoot(next);
			})
			.catch(() => {
				if (!cancelled) setRoot(null);
			});
		return () => {
			cancelled = true;
		};
	}, [texPath, roots, project]);

	return root;
}
