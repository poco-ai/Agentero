/** Source and compiled output share one workspace panel; neither can join a notes group alone. */
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	ResizableGroup,
	ResizableHandle,
	ResizablePanel,
} from "@/components/ui/resizable";
import {
	createWritingSelectionGroup,
	WritingSelectionGroupContext,
} from "@/components/writing/writing-selection-group";
import { useTexRoot } from "@/hooks/use-tex-root";
import { showTexProblemsView } from "@/lib/workspace/tex-compile";
import { WritingCloudBuildPreview } from "./writing-cloud-build";
import {
	useWritingCloudContext,
	WritingCloudProvider,
} from "./writing-cloud-context";
import { ProjectPdf } from "./writing-desk";
import { WritingPdfBar } from "./writing-pdf-bar";
import { WritingSyncButtons } from "./writing-sync-buttons";

export function TexProjectView({
	sourcePath,
	projectRoot,
	vaultPath,
	active,
	panelId,
	children,
}: {
	sourcePath: string;
	projectRoot: string;
	vaultPath: string;
	active: boolean;
	panelId: string;
	children: ReactNode;
}) {
	const root = useTexRoot(projectRoot) ?? projectRoot;
	const [live, setLive] = useState(false);
	const [cloud, setCloud] = useState(false);
	const [splitPosition, setSplitPosition] = useState(58);
	const selectionGroup = useMemo(createWritingSelectionGroup, []);
	// While focused, the problems button in the PDF bar reports failed
	// compiles of this root, so they do not also raise a toast.
	useEffect(
		() => (active ? showTexProblemsView(root) : undefined),
		[active, root],
	);
	return (
		<WritingSelectionGroupContext.Provider value={selectionGroup}>
			<WritingCloudProvider vault={vaultPath} root={root}>
				<div className="relative min-h-0 min-w-0 flex-1">
					<ResizableGroup
						orientation="horizontal"
						className="h-full min-h-0"
						onLayoutChange={(layout) =>
							setSplitPosition(layout["project-source"] ?? 58)
						}
					>
						<ResizablePanel
							id="project-source"
							defaultSize="58"
							minSize="24"
							className="flex min-h-0 min-w-0 flex-col"
						>
							{children}
						</ResizablePanel>
						<ResizableHandle className="z-30" />
						<ResizablePanel
							id="project-preview"
							defaultSize="42"
							minSize="20"
							className="flex min-h-0 min-w-0 flex-col"
						>
							<WritingCloudBuildPreview
								sourcePath={sourcePath}
								rootFile={root}
								vaultPath={vaultPath}
								active={active}
								panelId={panelId}
								cloud={cloud}
								onCloudChange={setCloud}
								local={
									<>
										<div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/70">
											<WritingPdfBar
												rootFile={root}
												livePreview={live}
												onLivePreviewChange={setLive}
												manageSync={active}
											/>
										</div>
										<div className="min-h-0 flex-1">
											<ProjectPdf
												key={root}
												rootFile={root}
												vaultPath={vaultPath}
												livePreview={live}
												active={active}
												instanceId={panelId}
											/>
										</div>
									</>
								}
							/>
						</ResizablePanel>
					</ResizableGroup>
					{!live && (
						<LocalSyncButtons
							cloud={cloud}
							activeFile={sourcePath}
							position={splitPosition}
						/>
					)}
				</div>
			</WritingCloudProvider>
		</WritingSelectionGroupContext.Provider>
	);
}

function LocalSyncButtons({
	cloud,
	activeFile,
	position,
}: {
	cloud: boolean;
	activeFile: string;
	position: number;
}) {
	const { session, state } = useWritingCloudContext();
	return cloud && session && state ? null : (
		<WritingSyncButtons activeFile={activeFile} position={position} />
	);
}
