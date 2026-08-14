/**
 * Lightweight root for `?window=viva`. Hosts the viva UI as the whole window
 * so the main workbench stays usable.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { VoiceDefenseHost } from "@/components/agent/voice-defense-host";
import { isTauri } from "@/lib/core/tauri";
import { refreshLibrary } from "@/lib/paper/library-store";
import {
	listenWorkspaceActive,
	type WorkspaceActiveChangedPayload,
} from "@/lib/shell/workspace-broadcast";
import { openRecentVault } from "@/lib/vault/actions";
import { initVaultStore, refreshTree } from "@/lib/vault/store";
import {
	listenVivaHandoff,
	readVivaWindowQuery,
	type VivaHandoffPayload,
} from "@/lib/voice-defense/viva-window";
import { initWorkspaceStore } from "@/lib/workspace/store";

export function VivaWindowRoot() {
	const { t } = useTranslation(["app"]);
	const bootQuery = useMemo(() => readVivaWindowQuery(), []);
	const [ready, setReady] = useState(false);
	const [followed, setFollowed] = useState<WorkspaceActiveChangedPayload>({
		path: bootQuery.activePath,
		vaultPath: bootQuery.vaultPath,
		paperTitle: bootQuery.paperTitle,
	});
	const [handoff, setHandoff] = useState<VivaHandoffPayload | null>(null);
	const handoffAppliedRef = useRef(false);

	useState(() => {
		initVaultStore();
		initWorkspaceStore();
		return null;
	});

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const vault = bootQuery.vaultPath;
			if (vault) {
				await openRecentVault(vault);
				if (!cancelled) {
					await refreshTree(vault);
					await refreshLibrary();
				}
			}
			if (!cancelled) setReady(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [bootQuery.vaultPath]);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void listenWorkspaceActive((payload) => {
			setFollowed(payload);
		}).then((dispose) => {
			unlisten = dispose;
		});
		return () => {
			unlisten?.();
		};
	}, []);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void listenVivaHandoff((payload) => {
			if (handoffAppliedRef.current) return;
			handoffAppliedRef.current = true;
			setHandoff(payload);
		}).then((dispose) => {
			unlisten = dispose;
		});
		return () => {
			unlisten?.();
		};
	}, []);

	useEffect(() => {
		if (!isTauri()) return;
		void (async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				await getCurrentWindow().setTitle(t("windows.titleViva"));
			} catch {
				// ignore
			}
		})();
	}, [t]);

	return (
		<div className="relative h-screen w-screen overflow-hidden bg-background">
			{ready ? (
				<VoiceDefenseHost
					windowMode
					followedPath={followed.path}
					followedPaperTitle={followed.paperTitle ?? null}
					handoffSelections={handoff?.selections}
					handoffAgentId={handoff?.selectedAgentId}
					handoffModelId={handoff?.modelId}
				/>
			) : (
				<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
					{t("windows.loading")}
				</div>
			)}
		</div>
	);
}
