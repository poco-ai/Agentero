import { Check, CloudUpload, Ellipsis, History } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DocumentTab } from "@/components/workspace/document-tab";
import {
	useWritingPathItems,
	WritingMenuContent,
	type WritingMenuItem,
} from "@/components/writing/writing-menu";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import {
	closeAllWritingFiles,
	closeOtherWritingFiles,
	closeWritingFile,
	closeWritingHistory,
	closeWritingSync,
	openWritingHistory,
	openWritingSync,
	setWritingFile,
	writingStore,
} from "@/lib/writing/store";

/**
 * Writing file tabs. Reuses the Dockview tab strip markup so the tabs look and
 * behave like the reading workspace instead of maintaining a second design.
 */
export function WritingFileTabs() {
	const { t } = useTranslation(["sidebar", "app"]);
	const tabs = useStore(writingStore, (state) => state.openFiles);
	const activeFile = useStore(writingStore, (state) => state.activeFile);
	const syncOpen = useStore(writingStore, (state) => state.syncOpen);
	const syncActive = useStore(writingStore, (state) => state.syncActive);
	const historyOpen = useStore(writingStore, (state) => state.historyOpen);
	const historyActive = useStore(writingStore, (state) => state.historyActive);
	const activeKey = activeFile == null ? null : normalizePath(activeFile);
	const stripRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [overflowing, setOverflowing] = useState(false);

	useLayoutEffect(() => {
		const strip = stripRef.current;
		const list = listRef.current;
		if (!strip || !list) return;
		const update = () =>
			setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(strip);
		observer.observe(list);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="flex min-w-0 flex-1 items-stretch">
			<div
				ref={stripRef}
				className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				<div
					ref={listRef}
					role="tablist"
					aria-label={t("writing.files")}
					className="h-full w-max"
				>
					<div className="agentero-dockview dv-groupview dv-active-group h-full [&_.dv-tabs-and-actions-container]:border-b-0! [&_.dv-tabs-and-actions-container]:bg-transparent!">
						<div className="dv-tabs-and-actions-container">
							<div className="dv-tabs-container dv-horizontal">
								{tabs.map((path) => {
									const key = normalizePath(path);
									return (
										<WritingFileTab
											key={key}
											path={path}
											selected={key === activeKey}
											closeOthersDisabled={
												tabs.length < 2 && !historyOpen && !syncOpen
											}
										/>
									);
								})}
								{historyOpen ? (
									<WritingAuxTab
										active={historyActive}
										title={t("writing.historyTab")}
										closeLabel={t("app:tabs.close", {
											title: t("writing.historyTab"),
										})}
										icon={<History className="size-3.5" aria-hidden />}
										onOpen={openWritingHistory}
										onClose={closeWritingHistory}
									/>
								) : null}
								{syncOpen ? (
									<WritingAuxTab
										active={syncActive}
										title={t("writing.sync")}
										closeLabel={t("app:tabs.close", {
											title: t("writing.sync"),
										})}
										icon={<CloudUpload className="size-3.5" aria-hidden />}
										onOpen={openWritingSync}
										onClose={closeWritingSync}
									/>
								) : null}
							</div>
						</div>
					</div>
				</div>
			</div>
			{overflowing ? (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="my-auto mr-0.5 shrink-0 text-muted-foreground"
							aria-label={t("app:tabs.more")}
							title={t("app:tabs.more")}
						>
							<Ellipsis aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						className="max-h-80 w-60 overflow-y-auto"
					>
						{tabs.map((path) => {
							const key = normalizePath(path);
							return (
								<DropdownMenuItem
									key={key}
									onSelect={() => setWritingFile(path)}
								>
									<Check
										className={cn(
											"size-3.5",
											key === activeKey ? "opacity-100" : "opacity-0",
										)}
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">
										{basenameOf(path)}
									</span>
								</DropdownMenuItem>
							);
						})}
						{historyOpen ? (
							<DropdownMenuItem onSelect={openWritingHistory}>
								<Check
									className={cn(
										"size-3.5",
										historyActive ? "opacity-100" : "opacity-0",
									)}
									aria-hidden
								/>
								<History className="size-3.5" aria-hidden />
								{t("writing.historyTab")}
							</DropdownMenuItem>
						) : null}
						{syncOpen ? (
							<DropdownMenuItem onSelect={openWritingSync}>
								<Check
									className={cn(
										"size-3.5",
										syncActive ? "opacity-100" : "opacity-0",
									)}
									aria-hidden
								/>
								<CloudUpload className="size-3.5" aria-hidden />
								{t("writing.sync")}
							</DropdownMenuItem>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</div>
	);
}

function WritingFileTab({
	path,
	selected,
	closeOthersDisabled,
}: {
	path: string;
	selected: boolean;
	closeOthersDisabled: boolean;
}) {
	const { t } = useTranslation(["sidebar", "app"]);
	const pathItems = useWritingPathItems(path);
	const title = basenameOf(path);
	const items: WritingMenuItem[] = [
		...pathItems,
		{
			id: "close",
			label: t("app:tabs.contextClose"),
			shortcut: formatShortcutById("closeTab"),
			separatorBefore: true,
			run: () => closeWritingFile(path),
		},
		{
			id: "close-others",
			label: t("app:tabs.contextCloseOthers"),
			disabled: closeOthersDisabled,
			run: () => closeOtherWritingFiles(path),
		},
		{
			id: "close-all",
			label: t("app:tabs.contextCloseAll"),
			run: () => closeAllWritingFiles(),
		},
	];
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="tab"
					data-hint
					aria-selected={selected}
					tabIndex={selected ? 0 : -1}
					title={title}
					className={cn(
						"dv-tab",
						selected ? "dv-active-tab" : "dv-inactive-tab",
					)}
					onClick={() => setWritingFile(path)}
					onAuxClick={(event) => {
						if (event.button === 1) {
							event.preventDefault();
							closeWritingFile(path);
						}
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							setWritingFile(path);
						}
					}}
				>
					<DocumentTab
						title={title}
						closeLabel={t("app:tabs.close", { title })}
						onClose={() => closeWritingFile(path)}
					/>
				</div>
			</ContextMenuTrigger>
			<WritingMenuContent items={items} />
		</ContextMenu>
	);
}

function WritingAuxTab({
	active,
	title,
	closeLabel,
	icon,
	onOpen,
	onClose,
}: {
	active: boolean;
	title: string;
	closeLabel: string;
	icon: ReactNode;
	onOpen: () => void;
	onClose: () => void;
}) {
	return (
		<div
			role="tab"
			data-hint
			aria-selected={active}
			tabIndex={active ? 0 : -1}
			title={title}
			className={cn("dv-tab", active ? "dv-active-tab" : "dv-inactive-tab")}
			onClick={onOpen}
			onAuxClick={(event) => {
				if (event.button === 1) {
					event.preventDefault();
					onClose();
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpen();
				}
			}}
		>
			<DocumentTab
				title={
					<span className="flex items-center gap-1.5">
						{icon}
						{title}
					</span>
				}
				closeLabel={closeLabel}
				onClose={onClose}
			/>
		</div>
	);
}
