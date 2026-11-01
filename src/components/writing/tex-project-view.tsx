/** Source and compiled output share one workspace panel; neither can join a notes group alone. */
import { type ReactNode, useEffect, useState } from "react";
import {
	ResizableGroup,
	ResizableHandle,
	ResizablePanel,
} from "@/components/ui/resizable";
import { useTexRoot } from "@/hooks/use-tex-root";
import { showTexProblemsView } from "@/lib/workspace/tex-compile";
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
	const [splitPosition, setSplitPosition] = useState(58);
	// While focused, the problems button in the PDF bar reports failed
	// compiles of this root, so they do not also raise a toast.
	useEffect(
		() => (active ? showTexProblemsView(root) : undefined),
		[active, root],
	);
	return (
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
				</ResizablePanel>
			</ResizableGroup>
			{!live && (
				<WritingSyncButtons activeFile={sourcePath} position={splitPosition} />
			)}
		</div>
	);
}
