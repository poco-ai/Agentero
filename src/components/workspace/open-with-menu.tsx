import {
	AppWindow,
	ChevronDown,
	FileCode2,
	FileText,
	FolderOpen,
	SquareTerminal,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SiArxiv,
	SiDoi,
	SiGithub,
	SiHuggingface,
	SiZhihu,
} from "react-icons/si";
import { ModelScopeIcon } from "@/components/icons/modelscope-icon";
import {
	AlphaXivIcon,
	OpenReviewIcon,
} from "@/components/icons/paper-service-icons";
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
import type { PaperMetadata } from "@/lib/paper";
import {
	openReviewSourceHref,
	paperLinkTargets,
} from "@/lib/paper/external-links";
import { askPaperOnZhihu } from "@/lib/paper/zhihu-ask";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import {
	type OpenWithApp,
	openPaperFolderWith,
	probeOpenWithApps,
} from "@/lib/system/open-with";
import {
	openFilePathInTerminal,
	revealFilePath,
} from "@/lib/workspace/file-path-actions";

type OpenWithMenuProps = {
	/** Paper body path; the Host opens its containing folder. */
	path: string;
	/** Paper metadata behind the Info sidebar's link chips. */
	meta: PaperMetadata | null;
	/** Paper HTML version, when known (metadata or the resolved tab asset). */
	htmlUrl: string | null;
};

/** Platform name of the default file manager row (brand names, not copy). */
function fileManagerName(): string {
	const os = getPlatformOS();
	if (os === "macos") return "Finder";
	if (os === "windows") return "File Explorer";
	return "File Manager";
}

/**
 * Rows before the Host probe resolves (or if it fails). Real app icons arrive
 * with the probe; these generic rows keep the control usable meanwhile.
 */
const FALLBACK_APPS: OpenWithApp[] = [
	{ id: "finder", name: fileManagerName(), kind: "fileManager", icon: null },
	{ id: "terminal", name: "Terminal", kind: "terminal", icon: null },
];

/** One row in the "Open links" section. */
type LinkRow = {
	id: string;
	label: string;
	icon: ReactNode;
	onSelect: () => void;
};

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
 * half opens the paper folder, the chevron lists the file manager (reveal in
 * Finder / Explorer, ⌥⌘R), installed editors, the preferred terminal (⌥⌘T),
 * and every external link card the Paper Info sidebar shows (arXiv, DOI,
 * alphaXiv, ModelScope, 知乎, GitHub, Hugging Face, OpenReview, PDF). The file
 * tree's right-click menu no longer repeats the Finder/Terminal rows, so this
 * menu shows their shortcuts. Icons are the real application icons extracted
 * by the Host; hand-drawn brand marks are intentionally avoided.
 */
export function OpenWithMenu({ path, meta, htmlUrl }: OpenWithMenuProps) {
	const { t } = useTranslation("app");
	const { t: tSidebar } = useTranslation("sidebar");
	const [apps, setApps] = useState<OpenWithApp[]>([]);
	/**
	 * Radix returns focus to the trigger when the menu closes. On WKWebView that
	 * programmatic focus is treated as `:focus-visible`, so a pointer dismissal
	 * left a theme-colored ring on the chevron. Keep the ring for keyboard
	 * dismissal (Esc), drop it when the menu was closed with the pointer.
	 */
	const pointerCloseRef = useRef(false);

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
	// Finder reveals the paper/source in the file manager (same action and
	// shortcut as the removed tree row); Terminal reuses the Settings terminal.
	const openRow = (app: OpenWithApp) => {
		if (app.kind === "fileManager") return revealFilePath(path);
		if (app.kind === "terminal") return openFilePathInTerminal(path);
		return openPaperFolderWith(app.id, path);
	};
	const shortcutFor = (app: OpenWithApp) =>
		app.kind === "fileManager"
			? formatShortcutById("revealInFinder")
			: app.kind === "terminal"
				? formatShortcutById("openInTerminal")
				: "";

	const targets = paperLinkTargets(meta);
	const links: LinkRow[] = [];
	const pushLink = (
		id: string,
		label: string,
		icon: ReactNode,
		href: string | null,
	) => {
		if (!href) return;
		links.push({ id, label, icon, onSelect: () => openExternalUrl(href) });
	};
	// Same chips as Paper Info; HTML comes first because it is a version of the
	// paper itself rather than an external service page.
	pushLink(
		"html",
		"HTML",
		<FileCode2 className="size-4 shrink-0 text-[#E34F26]" aria-hidden />,
		targets.htmlUrl ?? (openReviewSourceHref(htmlUrl) ? null : htmlUrl),
	);
	pushLink(
		"arxiv",
		tSidebar("paperInfo.arxiv"),
		<SiArxiv className="size-4 shrink-0 text-[#B31B1B]" aria-hidden />,
		targets.arxivUrl,
	);
	// DOI is listed independently: many arXiv papers also carry a journal DOI.
	pushLink(
		"doi",
		tSidebar("paperInfo.doi"),
		<SiDoi className="size-4 shrink-0 text-[#FCA2BD]" aria-hidden />,
		targets.doiUrl,
	);
	pushLink(
		"pdf",
		tSidebar("paperInfo.pdf"),
		<FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />,
		targets.openreviewUrl && targets.pdfUrl !== targets.arxivUrl
			? targets.pdfUrl
			: targets.arxivUrl || targets.doiUrl
				? null
				: targets.pdfUrl,
	);
	pushLink(
		"alphaxiv",
		tSidebar("paperInfo.alphaXiv"),
		<AlphaXivIcon className="size-4 shrink-0 text-[#B33131]" />,
		targets.alphaXivUrl,
	);
	pushLink(
		"modelscope",
		tSidebar("paperInfo.modelscopeInterpretation"),
		<ModelScopeIcon className="size-4 shrink-0" />,
		targets.modelScopeUrl,
	);
	const paper = meta;
	if (paper) {
		links.push({
			id: "zhihu",
			label: tSidebar("paperInfo.zhihu"),
			icon: <SiZhihu className="size-4 shrink-0 text-[#0084FF]" aria-hidden />,
			onSelect: () =>
				run(async () => {
					await askPaperOnZhihu(paper);
				}),
		});
	}
	pushLink(
		"github",
		tSidebar("paperInfo.codeRepo"),
		<SiGithub className="size-4 shrink-0" aria-hidden />,
		targets.codeRepoUrl,
	);
	pushLink(
		"huggingface",
		tSidebar("paperInfo.huggingface"),
		<SiHuggingface className="size-4 shrink-0 text-[#FF9D00]" aria-hidden />,
		targets.huggingFaceUrl,
	);
	pushLink(
		"openreview",
		tSidebar("paperInfo.openreview"),
		<OpenReviewIcon className="size-4 shrink-0" />,
		targets.openreviewUrl,
	);

	return (
		<div className="flex h-7 shrink-0 items-stretch overflow-hidden rounded-md bg-background/70 ring-1 ring-foreground/10">
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
			<DropdownMenu
				onOpenChange={(open) => {
					if (open) pointerCloseRef.current = false;
				}}
			>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("pathBar.openWith")}
						title={t("pathBar.openWith")}
						className="h-full w-6 rounded-none"
					>
						<ChevronDown className="size-3.5" aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					sideOffset={6}
					className="w-48"
					onPointerDown={() => {
						pointerCloseRef.current = true;
					}}
					onPointerDownOutside={() => {
						pointerCloseRef.current = true;
					}}
					onCloseAutoFocus={(event) => {
						if (!pointerCloseRef.current) return;
						pointerCloseRef.current = false;
						event.preventDefault();
					}}
				>
					{rows.map((app) => {
						const shortcut = shortcutFor(app);
						return (
							<DropdownMenuItem
								key={app.id}
								onSelect={() => run(() => openRow(app))}
							>
								<AppIcon app={app} />
								<span className="min-w-0 flex-1 truncate">{app.name}</span>
								{shortcut ? (
									<span className="ml-auto shrink-0 pl-2 text-muted-foreground text-xs tracking-wide">
										{shortcut}
									</span>
								) : null}
							</DropdownMenuItem>
						);
					})}
					{links.length > 0 ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="py-1">
								{t("pathBar.openLinks")}
							</DropdownMenuLabel>
							{links.map((link) => (
								<DropdownMenuItem key={link.id} onSelect={link.onSelect}>
									{link.icon}
									<span className="min-w-0 flex-1 truncate">{link.label}</span>
								</DropdownMenuItem>
							))}
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
