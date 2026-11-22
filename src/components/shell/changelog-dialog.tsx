import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { changelogStore, refreshChangelog } from "@/lib/update/changelog";
import { getUpdateReleaseUrl } from "@/lib/update/release";
import type { ChangelogView } from "@/lib/update/types";

const markdownOptions = { allowDangerousHtml: false };
const hiddenElements = ["img"];

function ReleaseSummary({ markdown }: { markdown: string }) {
	return (
		<Streamdown
			mode="static"
			controls={false}
			skipHtml
			remarkRehypeOptions={markdownOptions}
			disallowedElements={hiddenElements}
			linkSafety={{ enabled: false }}
			components={{
				a: ({ href, children }) =>
					href && /^https?:\/\//i.test(href) ? (
						<a
							href={href}
							className="text-primary underline underline-offset-2"
							onClick={(event) => {
								event.preventDefault();
								openExternalUrl(href);
							}}
						>
							{children}
						</a>
					) : (
						<span>{children}</span>
					),
			}}
			className="min-w-0 select-text space-y-2 wrap-break-word text-sm leading-relaxed [&_:is(h1,h2,h3,h4,h5,h6)]:mt-4 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:text-sm [&_:is(h1,h2,h3,h4,h5,h6)]:font-medium [&_li]:py-0 [&_li+li]:mt-1 [&_ul]:list-outside [&_ul]:pl-4"
		>
			{markdown}
		</Streamdown>
	);
}

function FullReleaseLink({ version }: { version: string }) {
	const { t } = useTranslation("settings");
	const url = getUpdateReleaseUrl(version);
	return (
		<Button variant="ghost" size="sm" asChild className="text-muted-foreground">
			<a
				href={url}
				onClick={(event) => {
					event.preventDefault();
					openExternalUrl(url);
				}}
			>
				{t("about.update.fullReleaseNotes")}
				<ExternalLink data-icon="inline-end" aria-hidden />
			</a>
		</Button>
	);
}

export default function ChangelogDialog({
	view,
	onClose,
	onCloseAutoFocus,
}: {
	view: ChangelogView;
	onClose: () => void;
	onCloseAutoFocus?: () => void;
}) {
	const { t, i18n } = useTranslation(["settings", "common"]);
	const language = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en";
	const data = useStore(changelogStore, (state) => state.data);
	const status = useStore(changelogStore, (state) => state.status);
	const [selectedTag, setSelectedTag] = useState<string>();
	const bodyRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const requestedVersion = view.kind === "release" ? view.version : undefined;
	const release =
		view.kind === "release"
			? data.releases.find((entry) => entry.tag === `v${view.version}`)
			: (data.releases.find((entry) => entry.tag === selectedTag) ??
				data.releases[0]);
	const version = requestedVersion ?? release?.tag.slice(1);
	const summary = release?.summary?.[language];
	const isCurrent = view.kind === "history" && version === view.currentVersion;
	const loading = status === "idle" || status === "loading";
	const dateFormat = new Intl.DateTimeFormat(language, {
		dateStyle: "medium",
		timeZone: "UTC",
	});

	useEffect(() => {
		void refreshChangelog(requestedVersion);
	}, [requestedVersion]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				aria-describedby={undefined}
				onOpenAutoFocus={(event) => {
					if (view.kind === "release") {
						event.preventDefault();
						titleRef.current?.focus();
					}
				}}
				onCloseAutoFocus={onCloseAutoFocus}
				className={cn(
					"flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col gap-3 overflow-hidden sm:max-w-lg motion-reduce:animate-none",
					view.kind === "history" && "h-[min(24.5rem,calc(100dvh-2rem))]",
				)}
			>
				<DialogHeader className="shrink-0">
					<DialogTitle
						ref={titleRef}
						tabIndex={-1}
						className="focus:outline-none"
					>
						{view.kind === "release"
							? `${t("about.update.releaseNotes")} · v${view.version}`
							: t("about.update.history")}
					</DialogTitle>
				</DialogHeader>
				{release && (
					<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
						{view.kind === "history" && (
							<Select
								value={release.tag}
								onValueChange={(tag) => {
									setSelectedTag(tag);
									bodyRef.current?.scrollTo({ top: 0 });
								}}
							>
								<SelectTrigger
									size="sm"
									aria-label={t("about.update.selectVersion")}
									className="min-w-24 text-foreground tabular-nums"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent
									position="popper"
									align="start"
									className="max-h-[min(16rem,var(--radix-select-content-available-height))] tabular-nums"
								>
									{data.releases.map(({ tag }) => (
										<SelectItem key={tag} value={tag}>
											{tag}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
						<time dateTime={release.releaseDate}>
							{dateFormat.format(new Date(release.releaseDate))}
						</time>
						{isCurrent && <span>{t("about.update.currentVersion")}</span>}
					</div>
				)}
				<div
					ref={bodyRef}
					className={cn(
						"min-h-0 overflow-y-auto overscroll-contain pr-1",
						view.kind === "history" && "flex-1",
					)}
				>
					{summary ? (
						<ReleaseSummary markdown={summary} />
					) : (
						<p
							role="status"
							className="flex items-center gap-2 text-muted-foreground"
						>
							{loading && view.kind === "release" && (
								<LoaderCircle
									aria-hidden
									className="size-4 animate-spin motion-reduce:animate-none"
								/>
							)}
							{t(
								loading && view.kind === "release"
									? "about.update.loadingNotes"
									: "about.update.noSummary",
							)}
						</p>
					)}
				</div>
				<DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-end gap-2 bg-transparent px-5 py-2.5">
					{status === "error" && (
						<div className="mr-auto flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
							<span role="status">{t("about.update.refreshNotesFailed")}</span>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => void refreshChangelog(requestedVersion, true)}
							>
								{t("common:tryAgain")}
							</Button>
						</div>
					)}
					{version && <FullReleaseLink version={version} />}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
