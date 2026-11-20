import {
	AppWindow,
	ChevronDown,
	FileCode2,
	FolderOpen,
	SquareTerminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SiArxiv } from "react-icons/si";
import { ModelScopeIcon } from "@/components/icons/modelscope-icon";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { getPlatformOS } from "@/lib/core/tauri";
import {
	type OpenWithApp,
	openPaperFolderWith,
	probeOpenWithApps,
} from "@/lib/system/open-with";
import { openFilePathInTerminal } from "@/lib/workspace/file-path-actions";

type OpenWithMenuProps = {
	/** Paper body path; the Host opens its containing folder. */
	path: string;
	/** Paper PDF URL, when known (arXiv chip prefers it over the arXiv page). */
	pdfUrl: string | null;
	/** Paper HTML version, when known. */
	htmlUrl: string | null;
	/** Normalized arXiv id, when known. */
	arxivId: string | null;
};

/** Platform name of the default file manager row (brand names, not copy). */
function fileManagerName(): string {
	const os = getPlatformOS();
	if (os === "macos") return "Finder";
	if (os === "windows") return "File Explorer";
	return "File Manager";
}

/**
 * Rows before the Host probe resolves (or if it fails). Real application icons
 * arrive with the probe; these generic rows keep the control usable meanwhile.
 */
const FALLBACK_APPS: OpenWithApp[] = [
	{ id: "finder", name: fileManagerName(), kind: "fileManager", icon: null },
	{ id: "terminal", name: "Terminal", kind: "terminal", icon: null },
];

/** Real application icon from the Host (PNG data URL), else a generic glyph. */
function AppIcon({ app }: { app: OpenWithApp }) {
	const [failed, setFailed] = useState(false);
	if (app.icon && !failed) {
		return (
			<img
				src={app.icon}
				alt=""
				width={16}
				height={16}
				draggable={false}
				className="size-4 shrink-0 rounded-[3px] object-contain"
				onError={() => setFailed(true)}
			/>
		);
	}
	const Icon =
		app.kind === "fileManager"
			? FolderOpen
			: app.kind === "terminal"
				? SquareTerminal
				: AppWindow;
	return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

/**
 * macOS-style "Open with" split control for the paper path bar: the Finder
 * half opens the paper folder, the chevron lists the Host's catalog — file
 * manager, installed editors, the preferred terminal — plus the paper's
 * external links. Icons are the real application icons extracted by the Host;
 * hand-drawn brand marks are intentionally avoided.
 */
export function OpenWithMenu({
	path,
	pdfUrl,
	htmlUrl,
	arxivId,
}: OpenWithMenuProps) {
	const { t } = useTranslation("app");
	const { t: tSidebar } = useTranslation("sidebar");
	const [apps, setApps] = useState<OpenWithApp[]>([]);

	// Probe once per session (module cache) so the menu is populated on open.
	useEffect(() => {
		let active = true;
		void probeOpenWithApps()
			.then((probed) => {
				if (active) setApps(probed);
			})
			.catch(() => {
				// Probe is best-effort; the generic rows still work.
			});
		return () => {
			active = false;
		};
	}, []);

	const run = (action: () => Promise<void>) => {
		void action().catch((error: unknown) => notifyError(errorText(error)));
	};

	const rows = apps.length > 0 ? apps : FALLBACK_APPS;
	const defaultApp = rows.find((app) => app.kind === "fileManager") ?? rows[0];
	const openRow = (app: OpenWithApp) =>
		app.kind === "terminal"
			? openFilePathInTerminal(path)
			: openPaperFolderWith(app.id, path);

	const modelScopeUrl = arxivId
		? `https://modelscope.cn/papers/${arxivId}/overview`
		: null;
	// Same target as the paper-info chip: the paper PDF URL, else the arXiv PDF.
	const arxivUrl =
		pdfUrl?.trim() || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : null);

	return (
		<div className="flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/80 bg-background/70">
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={t("pathBar.openFolder")}
				title={t("pathBar.openFolder")}
				className="h-full w-7 rounded-none"
				onClick={() => run(() => openPaperFolderWith("finder", path))}
			>
				<AppIcon app={defaultApp} />
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("pathBar.openWith")}
						title={t("pathBar.openWith")}
						className="h-full w-6 rounded-none border-border/80 border-l"
					>
						<ChevronDown className="size-3.5" aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" sideOffset={6} className="w-56">
					{rows.map((app) => (
						<DropdownMenuItem
							key={app.id}
							onSelect={() => run(() => openRow(app))}
						>
							<AppIcon app={app} />
							<span className="min-w-0 flex-1 truncate">{app.name}</span>
							{app.kind === "fileManager" ? (
								<span className="text-muted-foreground text-xs">
									{t("pathBar.default")}
								</span>
							) : null}
						</DropdownMenuItem>
					))}
					{htmlUrl || modelScopeUrl || arxivUrl ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="py-1">
								{t("pathBar.openLinks")}
							</DropdownMenuLabel>
							{htmlUrl ? (
								<DropdownMenuItem onSelect={() => openExternalUrl(htmlUrl)}>
									<FileCode2
										className="size-4 shrink-0 text-[#E34F26]"
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">HTML</span>
								</DropdownMenuItem>
							) : null}
							{modelScopeUrl ? (
								<DropdownMenuItem
									onSelect={() => openExternalUrl(modelScopeUrl)}
								>
									<ModelScopeIcon className="size-4 shrink-0" />
									<span className="min-w-0 flex-1 truncate">
										{tSidebar("paperInfo.modelscopeInterpretation")}
									</span>
								</DropdownMenuItem>
							) : null}
							{arxivUrl ? (
								<DropdownMenuItem onSelect={() => openExternalUrl(arxivUrl)}>
									<SiArxiv
										className="size-4 shrink-0 text-[#B31B1B]"
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">
										{tSidebar("paperInfo.arxiv")}
									</span>
								</DropdownMenuItem>
							) : null}
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
