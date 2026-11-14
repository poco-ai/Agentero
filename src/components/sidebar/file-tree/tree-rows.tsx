import {
	BookOpen,
	Bot,
	ChevronRight,
	Database,
	Download,
	Globe,
	Library,
	Link2,
	Loader2,
	Notebook,
	NotebookPen,
	ScrollText,
	Sparkles,
	Trash2,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { PaperTitle } from "@/components/paper/paper-title";
import { PLAZA_SOURCE_ICONS } from "@/components/plaza/source-icons";
import {
	FileTreeActions,
	FileTreeDisclosureIcon,
	FileTreeFile,
	FileTreeFolderRow,
	FileTreeIcon,
	FileTreeName,
	useFileTree,
} from "@/components/sidebar/file-tree/file-tree-primitives";
import { TreeRowActionButton } from "@/components/sidebar/tree-row-action-button";
import {
	TREE_ROW_INDENT_STEP_PX,
	TREE_ROW_INSET_PX,
} from "@/components/sidebar/tree-row-styles";
import { Skeleton } from "@/components/ui/skeleton";
import { NewProjectButton } from "@/components/writing/new-project-button";
import { ProjectSettingsButton } from "@/components/writing/project-settings-button";
import { WritingCloudDownloadButton } from "@/components/writing/writing-cloud-controls";
import { accountSurfaceEnabled } from "@/features/account/visibility";
import { useWritingProject } from "@/hooks/use-writing-project";
import { contextPathIcon } from "@/lib/agent/context-path-icon";
import { cn } from "@/lib/core/utils";
import { isPapersRoot } from "@/lib/paper";
import { TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import {
	PLAZA_VIRTUAL_PATH,
	type PlazaSource,
	plazaSourceLabel,
} from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";
import {
	isVaultAgentRoot,
	isVaultSkillDirectory,
	type SkillTreeLabel,
	skillDescriptionTooltip,
} from "@/lib/vault/agent-tree";
import { normalizePathKey } from "@/lib/vault/path";
import {
	sameWritingDirectory,
	writingLibraryRelative,
} from "@/lib/writing/project-manifest";
import type { TexCompileActions as TexCompileHookActions } from "./hooks/use-tex-compile";
import {
	DOWNLOAD_REASON_KEYS,
	fileTreeDisplayName,
	VAULT_ROOT_LABEL_KEY,
	type VaultRootFace,
	vaultRootFace,
} from "./tree-helpers";

/** Content inset shared by every row: base padding plus one step per level. */
export function treeRowIndentStyle(depth: number): CSSProperties {
	return {
		paddingLeft: TREE_ROW_INSET_PX + depth * TREE_ROW_INDENT_STEP_PX,
	};
}

type PaperTreeRowProps = {
	node: FileNode;
	depth: number;
	isCut: boolean;
	label: string;
	downloadReasons: Array<keyof typeof DOWNLOAD_REASON_KEYS>;
	isDownloading: boolean;
	isReading: boolean;
	rowBusy: boolean;
	expandable: boolean;
	expanded: boolean;
	onDownload?: () => void;
	onRead?: () => void;
};

export function PaperTreeRow({
	node,
	depth,
	isCut,
	label,
	downloadReasons,
	isDownloading,
	isReading,
	rowBusy,
	expandable,
	expanded,
	onDownload,
	onRead,
}: PaperTreeRowProps) {
	const { t } = useTranslation("sidebar");
	const { togglePath } = useFileTree();
	const expandLabel = expanded
		? t("fileTree.collapseChildren")
		: t("fileTree.expandChildren");
	const showDownload = Boolean(onDownload) && downloadReasons.length > 0;
	const showRead = Boolean(onRead) && !showDownload;
	const reasonTip = downloadReasons.length
		? downloadReasons.map((r) => t(DOWNLOAD_REASON_KEYS[r])).join(" · ")
		: t("fileTree.downloadAssets");
	const showActions = showDownload || showRead;
	return (
		<FileTreeFile
			path={node.path}
			name={label}
			data-hint
			className={cn(isCut && "opacity-50")}
			style={treeRowIndentStyle(depth)}
		>
			{expandable ? (
				<button
					type="button"
					aria-expanded={expanded}
					aria-label={expandLabel}
					className={cn(
						"group/attachment relative flex size-4 shrink-0 items-center justify-center",
						"text-muted-foreground focus-visible:outline-none",
					)}
					onClick={(e) => {
						e.stopPropagation();
						e.preventDefault();
						togglePath(node.path);
					}}
					onPointerDown={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					<ScrollText
						className="size-4 transition-opacity group-hover/attachment:opacity-0 group-focus-visible/attachment:opacity-0"
						aria-hidden
					/>
					<ChevronRight
						className={cn(
							"pointer-events-none absolute size-4 opacity-0 transition-[opacity,transform] group-hover/attachment:opacity-100 group-focus-visible/attachment:opacity-100",
							expanded && "rotate-90",
						)}
						aria-hidden
					/>
				</button>
			) : (
				<ScrollText
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden
				/>
			)}
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				<PaperTitle text={label} />
			</FileTreeName>
			{showActions ? (
				<FileTreeActions
					className="shrink-0"
					onClick={(e) => {
						e.stopPropagation();
					}}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{showDownload ? (
						<TreeRowActionButton
							label={reasonTip}
							tooltip={
								<>
									<p className="font-medium">{t("fileTree.downloadAssets")}</p>
									<ul className="mt-1 list-disc space-y-0.5 pl-3 text-xs opacity-90">
										{downloadReasons.map((r) => (
											<li key={r}>{t(DOWNLOAD_REASON_KEYS[r])}</li>
										))}
									</ul>
								</>
							}
							tooltipClassName="flex-col items-start gap-0"
							disabled={rowBusy}
							onClick={(e) => {
								e.stopPropagation();
								onDownload?.();
							}}
						>
							{isDownloading ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Download className="size-3.5" />
							)}
						</TreeRowActionButton>
					) : null}
					{showRead ? (
						<TreeRowActionButton
							label={t("fileTree.readPaper")}
							data-read-paper
							disabled={rowBusy}
							onClick={(e) => {
								e.stopPropagation();
								onRead?.();
							}}
						>
							{isReading ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<NotebookPen className="size-3.5" />
							)}
						</TreeRowActionButton>
					) : null}
				</FileTreeActions>
			) : null}
		</FileTreeFile>
	);
}

type NodeTreeRowProps = {
	node: FileNode;
	depth: number;
	isCut: boolean;
	pendingLoad: boolean;
	expanded: boolean;
	texCompile?: TexCompileHookActions;
	vaultPath?: string | null;
	skillLabels?: ReadonlyMap<string, SkillTreeLabel>;
};

export function NodeTreeRow({
	node,
	depth,
	isCut,
	pendingLoad,
	expanded,
	vaultPath,
	skillLabels,
}: NodeTreeRowProps) {
	const { t } = useTranslation("sidebar");
	const lookup = useWritingProject(
		vaultPath,
		node.kind === "directory" ? node.path : null,
		true,
	);
	if (
		node.kind === "directory" &&
		isVaultSkillDirectory(vaultPath, node.path)
	) {
		const label = skillLabels?.get(normalizePathKey(node.path));
		return (
			<SkillTreeRow
				node={node}
				depth={depth}
				isCut={isCut}
				label={label?.name || node.name}
				description={skillDescriptionTooltip(label?.description ?? "")}
				expanded={expanded}
				pendingLoad={pendingLoad}
			/>
		);
	}
	if (node.kind === "directory") {
		// `papers/` doubles as the library entry: library icon + title.
		// Vault-root notes/thesis/data, and `.agents`, get an icon + label.
		// Disk names stay unchanged.
		const isLibraryRoot = isPapersRoot(node.path);
		const isAgentRoot = isVaultAgentRoot(vaultPath, node.path);
		const rootFace =
			isLibraryRoot || isAgentRoot ? null : vaultRootFace(vaultPath, node.path);
		const rel = vaultPath ? writingLibraryRelative(vaultPath, node.path) : null;
		const owningProject = lookup.status === "ready" ? lookup.project : null;
		const project =
			owningProject && sameWritingDirectory(owningProject.directory, node.path)
				? owningProject
				: null;
		return (
			<div
				className={cn(
					"relative flex w-full items-center",
					isCut && "opacity-50",
				)}
				{...(isLibraryRoot ? { "data-library-row": "" } : {})}
				{...(isAgentRoot ? { "data-vault-root": "agents" } : {})}
				{...(rootFace ? { "data-vault-root": rootFace } : {})}
				{...(project
					? { "data-writing-project": project.manifest.projectId }
					: {})}
			>
				<FileTreeFolderRow
					openOnLabel={Boolean(
						isAgentRoot || project || (rel && lookup.status === "error"),
					)}
					expandOnOpen={Boolean(project)}
					path={node.path}
					style={treeRowIndentStyle(depth)}
					name={
						isLibraryRoot
							? t("papersLibrary.title")
							: isAgentRoot
								? t("fileTree.vaultRoot.agents")
								: rootFace
									? t(
											rootFace === "thesis"
												? "writing.write"
												: VAULT_ROOT_LABEL_KEY[rootFace],
										)
									: (project?.manifest.name ?? node.name)
					}
					icon={
						isLibraryRoot ? (
							<Library className="size-4 text-muted-foreground" />
						) : isAgentRoot ? (
							<Bot className="size-4 text-muted-foreground" aria-hidden />
						) : rootFace ? (
							<VaultRootIcon face={rootFace} />
						) : project ? (
							<BookOpen className="size-4 text-muted-foreground" aria-hidden />
						) : undefined
					}
					actions={
						vaultPath && project ? (
							<ProjectSettingsButton vault={vaultPath} project={project} />
						) : vaultPath &&
							(rootFace === "thesis" ||
								(rel && lookup.status === "ready" && !owningProject)) ? (
							<>
								<NewProjectButton vaultPath={vaultPath} parent={node.path} />
								{accountSurfaceEnabled && (
									<WritingCloudDownloadButton
										vault={vaultPath}
										collection={node.path}
									/>
								)}
							</>
						) : undefined
					}
				/>
				{pendingLoad && expanded ? (
					<Loader2
						className="pointer-events-none absolute right-2 size-3.5 shrink-0 animate-spin text-muted-foreground"
						aria-hidden
					/>
				) : null}
			</div>
		);
	}

	const Icon = contextPathIcon(node.name);
	const display = fileTreeDisplayName(node.name);

	return (
		<FileTreeFile
			path={node.path}
			name={node.name}
			className={cn(isCut && "opacity-50")}
			style={treeRowIndentStyle(depth)}
		>
			<FileTreeIcon>
				<Icon className="size-4 text-muted-foreground" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate" title={node.name}>
				{display}
			</FileTreeName>
		</FileTreeFile>
	);
}

function SkillTreeRow({
	node,
	depth,
	isCut,
	label,
	description,
	expanded,
	pendingLoad,
}: {
	node: FileNode;
	depth: number;
	isCut: boolean;
	label: string;
	description: string;
	expanded: boolean;
	pendingLoad: boolean;
}) {
	const { t } = useTranslation("sidebar");
	const { togglePath } = useFileTree();
	const expandable =
		Boolean(node.childrenPending) || (node.children?.length ?? 0) > 0;
	const expandLabel = expanded
		? t("fileTree.collapseChildren")
		: t("fileTree.expandChildren");
	const tip = description || label;
	return (
		<div
			className={cn("relative flex w-full items-center", isCut && "opacity-50")}
		>
			<FileTreeFile
				path={node.path}
				name={label}
				className="min-w-0 flex-1"
				style={treeRowIndentStyle(depth)}
			>
				{expandable ? (
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={expandLabel}
						className="group/skill relative flex size-4 shrink-0 items-center justify-center text-muted-foreground focus-visible:outline-none"
						onClick={(e) => {
							e.stopPropagation();
							e.preventDefault();
							togglePath(node.path);
						}}
						onPointerDown={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						<Sparkles
							className="size-4 transition-opacity group-hover/skill:opacity-0 group-focus-visible/skill:opacity-0"
							aria-hidden
						/>
						<ChevronRight
							className={cn(
								"pointer-events-none absolute size-4 opacity-0 transition-[opacity,transform] group-hover/skill:opacity-100 group-focus-visible/skill:opacity-100",
								expanded && "rotate-90",
							)}
							aria-hidden
						/>
					</button>
				) : (
					<Sparkles
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
				)}
				<FileTreeName className="min-w-0 flex-1 truncate" title={tip}>
					{label}
				</FileTreeName>
			</FileTreeFile>
			{pendingLoad && expanded ? (
				<Loader2
					className="pointer-events-none absolute right-2 size-3.5 shrink-0 animate-spin text-muted-foreground"
					aria-hidden
				/>
			) : null}
		</div>
	);
}

function VaultRootIcon({ face }: { face: VaultRootFace }) {
	const Icon =
		face === "notes" ? Notebook : face === "thesis" ? ScrollText : Database;
	return <Icon className="size-4 text-muted-foreground" aria-hidden />;
}

export function TrashRow() {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile path={TRASH_VIRTUAL_PATH} name={t("recycleBin.title")}>
			<FileTreeIcon>
				<Trash2 className="size-4 text-muted-foreground" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("recycleBin.title")}
			</FileTreeName>
		</FileTreeFile>
	);
}

/** 广场 parent row — collapsible, with the discovery sources as children. */
export function PlazaRow({ expanded }: { expanded: boolean }) {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile
			path={PLAZA_VIRTUAL_PATH}
			name={t("plaza.plaza")}
			aria-expanded={expanded}
		>
			<FileTreeDisclosureIcon
				isExpanded={expanded}
				icon={<Globe className="size-4 text-muted-foreground" aria-hidden />}
			/>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("plaza.plaza")}
			</FileTreeName>
		</FileTreeFile>
	);
}

export function PlazaSourceRow({
	source,
	style,
}: {
	source: PlazaSource;
	style?: CSSProperties;
}) {
	const Icon = PLAZA_SOURCE_ICONS[source.icon];
	const label = plazaSourceLabel(source);
	return (
		<FileTreeFile
			path={source.path}
			name={label}
			style={style}
			{...(source.id === "cool-papers" ? { "data-cool-papers": "" } : {})}
		>
			<FileTreeIcon>
				<Icon className="size-4" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				{label}
			</FileTreeName>
		</FileTreeFile>
	);
}

/** A reference rendered in another Zotero collection, not a second paper. */
export function ZoteroCollectionReferenceRow({
	path,
	label,
	depth,
}: {
	path: string;
	label: string;
	depth: number;
}) {
	return (
		<FileTreeFile path={path} name={label} style={treeRowIndentStyle(depth)}>
			<FileTreeIcon>
				<Link2 className="size-4 text-muted-foreground" aria-hidden />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				<PaperTitle text={label} />
			</FileTreeName>
		</FileTreeFile>
	);
}

export function LoadingRows() {
	return (
		<div className="space-y-1 px-2 py-1.5" aria-hidden>
			{["one", "two", "three", "four", "five"].map((key, index) => (
				<div key={key} className="flex h-7 items-center gap-2 rounded-md px-2">
					<Skeleton className="size-4 shrink-0 library-shimmer" />
					<Skeleton
						className={cn(
							"library-shimmer h-3",
							index === 0 ? "w-32" : index === 1 ? "w-24" : "w-28",
						)}
					/>
				</div>
			))}
		</div>
	);
}
