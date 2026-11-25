import { Command as CommandPrimitive } from "cmdk";
import {
	FileText,
	Loader2,
	Search,
	Settings2,
	SquareTerminal,
	Table,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

import { buildPaperSearchText } from "@/components/library/library-row-utils";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	useLibraryStore,
	useUiStore,
	useVaultStore,
} from "@/hooks/use-app-stores";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { closeAgentWindow } from "@/lib/agent/agent-window";
import type { PaperMetadata } from "@/lib/paper";
import { paperDirFromPath } from "@/lib/paper/detect";
import { editablePaperTags } from "@/lib/paper/tags";
import { isResearchTablePath } from "@/lib/research-table/model";
import { filterByFuzzy } from "@/lib/shell/commands/match";
import {
	commandRegistryRevision,
	listCommands,
	subscribeCommands,
} from "@/lib/shell/commands/registry";
import {
	commandCategory,
	commandTitle,
	type PaletteMode,
} from "@/lib/shell/commands/types";
import { openPalette, setCommandOpen } from "@/lib/shell/ui-store";
import { joinVaultPath } from "@/lib/vault";
import { type SearchHit, searchVault } from "@/lib/vault/search";
import { searchWikiLinks, type WikiSearchCandidate } from "@/lib/wiki/api";
import { openPaper, openVaultRel } from "@/lib/workspace/actions";

const PAPER_LIMIT = 8;
const ALIAS_LIMIT = 8;

/** User-facing tag names for a catalog row (system projections hidden). */
function tagNames(paper: PaperMetadata): string[] {
	return editablePaperTags(paper.tags).map((tag) => tag.name);
}

/**
 * Title-bar quick open (⌘P) / commands (⇧⌘P).
 *
 * VS Code-style: the input lives in the middle of the title bar and results
 * drop below it, instead of a centered modal. Go mode searches papers, Wiki
 * aliases, and Vault contents; a leading `>` (or ⇧⌘P) switches to commands.
 */
export function QuickOpen() {
	const { t } = useTranslation("app");
	const quickOpenShortcut = useShortcutLabel("quickOpen");
	const open = useUiStore((s) => s.commandOpen);
	const mode: PaletteMode = useUiStore((s) => s.commandMode);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const papers = useLibraryStore((s) => s.papers);
	// Re-render when commands are registered or unregistered after mount;
	// `listCommands()` is then re-read on that render.
	useSyncExternalStore(subscribeCommands, commandRegistryRevision);

	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[]>([]);
	const [aliasHits, setAliasHits] = useState<WikiSearchCandidate[]>([]);
	const [loading, setLoading] = useState(false);
	const genRef = useRef(0);
	const aliasGenRef = useRef(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Opening focuses the input; ⇧⌘P while open re-seeds it with `>`.
	// Closing clears the draft so the next open starts clean.
	useEffect(() => {
		if (!open) {
			setQuery("");
			setHits([]);
			setAliasHits([]);
			setLoading(false);
			return;
		}
		setQuery(mode === "commands" ? ">" : "");
		const input = inputRef.current;
		input?.focus();
		input?.select();
	}, [open, mode]);

	useOverlayRegistration("quick-open", open, () => setCommandOpen(false));

	// Clicking anywhere outside the field or its results dismisses it, like
	// VS Code. There is no scrim, so the workspace stays visible underneath.
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (rootRef.current?.contains(event.target as Node)) return;
			setCommandOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () =>
			document.removeEventListener("pointerdown", onPointerDown, true);
	}, [open]);

	const effectiveMode: PaletteMode = useMemo(() => {
		const q = query.trimStart();
		if (q.startsWith(">")) return "commands";
		return mode;
	}, [query, mode]);

	const commandQuery = useMemo(() => {
		const q = query.trimStart();
		if (q.startsWith(">")) return q.slice(1).trimStart();
		return effectiveMode === "commands" ? q : "";
	}, [query, effectiveMode]);

	const goQuery = useMemo(() => {
		if (effectiveMode === "commands") return "";
		const q = query.trimStart();
		return q.startsWith(">") ? q.slice(1) : q;
	}, [query, effectiveMode]);

	const resolvedCommands = listCommands();
	const translate = useCallback(
		(key: string) => t(key as "commandPalette.title"),
		[t],
	);

	const visibleCommands = useMemo(() => {
		const available = resolvedCommands.filter((c) =>
			c.when ? c.when() : true,
		);
		return filterByFuzzy(available, commandQuery, (c) => {
			const title = commandTitle(c, translate);
			const cat = commandCategory(c, translate);
			const kw = c.keywords?.join(" ") ?? "";
			return `${cat} ${title} ${kw} ${c.id}`;
		});
	}, [resolvedCommands, commandQuery, translate]);

	// PERF: precompute each paper's haystack once per catalog snapshot
	// (buildPaperSearchText — same source as the library table filter) so
	// per-keystroke filtering only runs `includes` on cached strings.
	const searchRows = useMemo(() => {
		const rows: { paper: PaperMetadata; hay: string }[] = [];
		for (const p of papers) {
			if (!p.path) continue;
			rows.push({ paper: p, hay: buildPaperSearchText(p) });
		}
		return rows;
	}, [papers]);

	// Instant, in-memory paper matches (title / identifiers / path / authors /
	// tags). Empty query → recents.
	const paperMatches = useMemo(() => {
		if (effectiveMode !== "go") return [];
		const terms = goQuery.toLowerCase().split(/\s+/).filter(Boolean);
		if (!terms.length) {
			return searchRows.slice(0, PAPER_LIMIT).map((r) => r.paper);
		}
		return searchRows
			.filter((r) => terms.every((term) => r.hay.includes(term)))
			.slice(0, PAPER_LIMIT)
			.map((r) => r.paper);
	}, [searchRows, goQuery, effectiveMode]);

	// Debounced backend full-text search over Vault Markdown. Every run takes a
	// new generation so a reply for an older query/mode cannot land.
	useEffect(() => {
		const gen = ++genRef.current;
		if (!open || !vaultPath || effectiveMode !== "go") {
			setHits([]);
			setLoading(false);
			return;
		}
		const q = goQuery.trim();
		if (!q) {
			setHits([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		const timer = setTimeout(() => {
			searchVault({ vaultPath, query: q, limit: 60 })
				.then((r) => {
					if (gen === genRef.current) setHits(r.hits);
				})
				.catch(() => {
					if (gen === genRef.current) setHits([]);
				})
				.finally(() => {
					if (gen === genRef.current) setLoading(false);
				});
		}, 200);
		return () => clearTimeout(timer);
	}, [goQuery, open, vaultPath, effectiveMode]);

	// Debounced frontmatter-alias search over Vault Markdown (Wiki index). Only
	// alias rows are kept — path/heading/block matches would duplicate the other
	// tiers, and alias rows are exactly what the paper/content tiers can't see.
	useEffect(() => {
		const gen = ++aliasGenRef.current;
		if (!open || !vaultPath || effectiveMode !== "go") {
			setAliasHits([]);
			return;
		}
		const q = goQuery.trim();
		if (!q) {
			setAliasHits([]);
			return;
		}
		const timer = setTimeout(() => {
			searchWikiLinks(vaultPath, q, { kind: "file" })
				.then((r) => {
					if (gen !== aliasGenRef.current) return;
					setAliasHits(r.filter((c) => c.alias).slice(0, ALIAS_LIMIT));
				})
				.catch(() => {
					if (gen === aliasGenRef.current) setAliasHits([]);
				});
		}, 200);
		return () => clearTimeout(timer);
	}, [goQuery, open, vaultPath, effectiveMode]);

	// Drop aliases already shown as a paper row (the paper tier wins), and drop
	// content hits whose file is already shown as an alias row.
	const aliasRows = useMemo(() => {
		const paperPaths = new Set(paperMatches.map((p) => p.path as string));
		return aliasHits.filter((c) => {
			const paperRel = paperDirFromPath(c.path);
			return !(paperRel && paperPaths.has(paperRel));
		});
	}, [aliasHits, paperMatches]);

	const contentHits = useMemo(() => {
		if (!aliasHits.length) return hits;
		const aliasPaths = new Set(aliasHits.map((c) => c.path));
		return hits.filter((hit) => !aliasPaths.has(hit.path));
	}, [hits, aliasHits]);

	const close = () => setCommandOpen(false);
	const openPaperRel = (rel: string) => {
		if (vaultPath) openPaper(joinVaultPath(vaultPath, rel));
	};
	const revealWorkspace = () => {
		// Opening a document from Agent mode would land in the hidden document
		// dock; drop back to the workspace first.
		closeAgentWindow();
	};
	const choosePaper = (rel: string) => {
		revealWorkspace();
		openPaperRel(rel);
		close();
	};
	const chooseHit = (hit: SearchHit) => {
		revealWorkspace();
		if (hit.paperPath) openPaperRel(hit.paperPath);
		else openVaultRel(hit.path);
		close();
	};
	const chooseAlias = (candidate: WikiSearchCandidate) => {
		revealWorkspace();
		const paperRel = paperDirFromPath(candidate.path);
		if (paperRel) openPaperRel(paperRel);
		else openVaultRel(candidate.path);
		close();
	};
	const runCommand = (run: () => void | Promise<void>) => {
		close();
		void Promise.resolve(run()).catch(() => undefined);
	};

	const hasGoResults =
		paperMatches.length > 0 || aliasRows.length > 0 || contentHits.length > 0;
	const hasCmdResults = visibleCommands.length > 0;

	const placeholder =
		effectiveMode === "commands"
			? t("commandPalette.commandsPlaceholder")
			: t("commandPalette.placeholder");
	const panelTitle =
		effectiveMode === "commands"
			? t("commandPalette.commandsTitle")
			: t("commandPalette.title");

	return (
		<div
			ref={rootRef}
			className="relative flex w-[clamp(12rem,24vw,20rem)] shrink-0 items-center"
		>
			{open ? (
				<Command
					shouldFilter={false}
					loop
					label={panelTitle}
					className="contents"
				>
					<div className="flex h-[1.375rem] w-full items-center gap-1.5 rounded-md border border-ring/50 bg-background px-1.5 text-foreground ring-1 ring-ring/20 transition-colors duration-100 focus-within:border-ring/70">
						<Search className="size-3 shrink-0 text-muted-foreground" />
						<CommandPrimitive.Input
							ref={inputRef}
							value={query}
							onValueChange={setQuery}
							placeholder={placeholder}
							className="min-w-0 flex-1 select-text bg-transparent text-xs outline-hidden placeholder:text-muted-foreground/80"
						/>
						<kbd className="pointer-events-none shrink-0 rounded border border-border/60 bg-muted/60 px-1 font-sans text-[0.625rem] text-muted-foreground leading-3.5">
							{quickOpenShortcut}
						</kbd>
					</div>
					{/* Results layer: anchored to the field, no scrim or dialog. */}
					<div className="absolute top-full left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 pt-1.5">
						<div className="animate-in fade-in-0 overflow-hidden rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-dialog duration-100">
							<CommandList className="max-h-[min(24rem,60vh)]">
								{effectiveMode === "commands" ? (
									hasCmdResults ? (
										<CommandGroup heading={t("commandPalette.commands")}>
											{visibleCommands.map((cmd) => {
												const titleText = commandTitle(cmd, translate);
												const catText = commandCategory(cmd, translate);
												return (
													<CommandItem
														key={cmd.id}
														value={`cmd:${cmd.id}`}
														onSelect={() => runCommand(() => cmd.run())}
													>
														<CommandIcon id={cmd.id} />
														<div className="flex min-w-0 flex-col">
															<span className="truncate">
																{catText ? (
																	<>
																		<span className="text-muted-foreground">
																			{catText}:{" "}
																		</span>
																		{titleText}
																	</>
																) : (
																	titleText
																)}
															</span>
														</div>
													</CommandItem>
												);
											})}
										</CommandGroup>
									) : (
										<div className="px-3 py-6 text-center text-muted-foreground text-sm">
											{commandQuery
												? t("commandPalette.noResults")
												: t("commandPalette.commandsEmpty")}
										</div>
									)
								) : (
									<>
										{paperMatches.length ? (
											<CommandGroup
												heading={
													goQuery
														? t("commandPalette.papers")
														: t("commandPalette.recent")
												}
											>
												{paperMatches.map((p) => {
													const tags = tagNames(p);
													const meta = [
														p.authors?.join(", "),
														p.year ? String(p.year) : null,
														tags.length ? tags.join(", ") : null,
													]
														.filter(Boolean)
														.join(" · ");
													return (
														<CommandItem
															key={p.path}
															value={`paper:${p.path}`}
															onSelect={() => choosePaper(p.path as string)}
														>
															<FileText className="text-muted-foreground" />
															<div className="flex min-w-0 flex-col">
																<span className="truncate">
																	{p.title || p.id}
																</span>
																{meta ? (
																	<span className="truncate text-muted-foreground text-xs">
																		{meta}
																	</span>
																) : null}
															</div>
														</CommandItem>
													);
												})}
											</CommandGroup>
										) : null}

										{aliasRows.length ? (
											<CommandGroup heading={t("commandPalette.aliases")}>
												{aliasRows.map((candidate) => (
													<CommandItem
														key={`alias:${candidate.path}:${candidate.label}`}
														value={`alias:${candidate.path}:${candidate.label}`}
														onSelect={() => chooseAlias(candidate)}
													>
														<FileText className="text-muted-foreground" />
														<div className="flex min-w-0 flex-col">
															<span className="truncate">
																{candidate.label}
															</span>
															<span className="truncate text-muted-foreground text-xs">
																{candidate.path}
															</span>
														</div>
													</CommandItem>
												))}
											</CommandGroup>
										) : null}

										{contentHits.length ? (
											<CommandGroup heading={t("commandPalette.contents")}>
												{contentHits.map((hit) => (
													<CommandItem
														key={hit.path}
														value={`hit:${hit.path}`}
														onSelect={() => chooseHit(hit)}
													>
														{isResearchTablePath(hit.path) ? (
															<Table className="text-muted-foreground" />
														) : (
															<FileText className="text-muted-foreground" />
														)}
														<div className="flex min-w-0 flex-col">
															<span className="truncate">{hit.title}</span>
															<span className="truncate text-muted-foreground text-xs">
																{hit.snippet}
															</span>
														</div>
													</CommandItem>
												))}
											</CommandGroup>
										) : null}

										{loading ? (
											<div className="flex items-center gap-2 px-3 py-3 text-muted-foreground text-xs">
												<Loader2 className="size-3.5 animate-spin" />
												{t("commandPalette.searching")}
											</div>
										) : null}

										{!loading && !hasGoResults ? (
											<div className="px-3 py-6 text-center text-muted-foreground text-sm">
												{!vaultPath
													? t("commandPalette.noVault")
													: goQuery
														? t("commandPalette.noResults")
														: t("commandPalette.empty")}
											</div>
										) : null}
									</>
								)}
							</CommandList>
						</div>
					</div>
				</Command>
			) : (
				<button
					type="button"
					onClick={() => openPalette("go")}
					aria-label={t("commandPalette.title")}
					className="group flex h-[1.375rem] w-full items-center gap-1.5 rounded-md border border-transparent bg-muted/30 px-1.5 text-muted-foreground text-xs transition-colors duration-100 hover:bg-muted/60 hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none"
				>
					<Search className="size-3 shrink-0 opacity-70" />
					<span className="min-w-0 flex-1 truncate text-left">
						{t("commandPalette.placeholder")}
					</span>
					<kbd className="pointer-events-none shrink-0 rounded border border-border/60 bg-muted/60 px-1 font-sans text-[0.625rem] text-muted-foreground leading-3.5">
						{quickOpenShortcut}
					</kbd>
				</button>
			)}
		</div>
	);
}

function CommandIcon({ id }: { id: string }) {
	const Icon = id.startsWith("settings.")
		? Settings2
		: id.startsWith("vault.") || id.startsWith("library.")
			? FileText
			: SquareTerminal;
	return <Icon className="text-muted-foreground" />;
}
