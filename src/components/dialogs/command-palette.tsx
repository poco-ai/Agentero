import {
	FileText,
	Loader2,
	type LucideIcon,
	Settings2,
	SquareTerminal,
	Table,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildPaperSearchText } from "@/components/library/library-row-utils";
import {
	Command,
	CommandDialog,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import type { PaperMetadata } from "@/lib/paper";
import { paperDirFromPath } from "@/lib/paper/detect";
import { editablePaperTags } from "@/lib/paper/tags";
import { isResearchTablePath } from "@/lib/research-table/model";
import { filterByFuzzy } from "@/lib/shell/commands/match";
import { listCommands } from "@/lib/shell/commands/registry";
import {
	type AppCommand,
	commandCategory,
	commandTitle,
	type PaletteMode,
} from "@/lib/shell/commands/types";
import { type SearchHit, searchVault } from "@/lib/vault/search";
import { searchWikiLinks, type WikiSearchCandidate } from "@/lib/wiki/api";

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Initial mode when opening (⇧⌘P → commands, ⌘P → go) */
	mode: PaletteMode;
	vaultPath: string | null;
	/** In-memory catalog rows for instant title/author quick-open. */
	papers: PaperMetadata[];
	/**
	 * Commands for ⇧⌘P / `>` mode. While the palette is open this component
	 * re-reads the registry, so a registration after the parent rendered
	 * still shows up on the next palette render.
	 */
	commands: AppCommand[];
	/** Open a paper by its vault-relative folder (e.g. papers/x). */
	onOpenPaper: (paperRel: string) => void;
	/** Open a vault-relative file (e.g. notes/idea.md). */
	onOpenVaultRel: (rel: string) => void;
};

const PAPER_LIMIT = 8;
const ALIAS_LIMIT = 8;

/** User-facing tag names for a catalog row (system projections hidden). */
function tagNames(paper: PaperMetadata): string[] {
	return editablePaperTags(paper.tags).map((tag) => tag.name);
}

/**
 * Global palette: Go (⌘P) = papers + vault search;
 * Commands (⇧⌘P) = executable app actions. Leading `>` forces commands mode.
 */
export function CommandPalette({
	open,
	onOpenChange,
	mode,
	vaultPath,
	papers,
	commands,
	onOpenPaper,
	onOpenVaultRel,
}: CommandPaletteProps) {
	const { t } = useTranslation("app");
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[]>([]);
	const [loading, setLoading] = useState(false);
	const genRef = useRef(0);
	// Alias matches come from the Wiki index (frontmatter `aliases`); separate
	// generation counter so the two async searches never clobber each other.
	const [aliasHits, setAliasHits] = useState<WikiSearchCandidate[]>([]);
	const aliasGenRef = useRef(0);

	// Reset query when opening or when mode changes while open.
	useEffect(() => {
		if (open) setQuery(mode === "commands" ? ">" : "");
	}, [open, mode]);

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
		return query.trimStart().startsWith(">")
			? query.trimStart().slice(1)
			: query;
	}, [query, effectiveMode]);

	const resolvedCommands = open ? listCommands() : commands;
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

	// Instant, in-memory paper matches (searchText: title / identifiers /
	// path / authors / tags). Empty query → recents.
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

	// Debounced backend full-text search over Vault Markdown.
	useEffect(() => {
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
		const gen = ++genRef.current;
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
		if (!open || !vaultPath || effectiveMode !== "go") {
			setAliasHits([]);
			return;
		}
		const q = goQuery.trim();
		if (!q) {
			setAliasHits([]);
			return;
		}
		const gen = ++aliasGenRef.current;
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

	const choosePaper = (rel: string) => {
		onOpenPaper(rel);
		onOpenChange(false);
	};
	const chooseHit = (hit: SearchHit) => {
		if (hit.paperPath) onOpenPaper(hit.paperPath);
		else onOpenVaultRel(hit.path);
		onOpenChange(false);
	};
	const chooseAlias = (candidate: WikiSearchCandidate) => {
		const paperRel = paperDirFromPath(candidate.path);
		if (paperRel) onOpenPaper(paperRel);
		else onOpenVaultRel(candidate.path);
		onOpenChange(false);
	};
	const runCommand = (cmd: AppCommand) => {
		onOpenChange(false);
		void Promise.resolve(cmd.run()).catch(() => undefined);
	};

	const hasGoResults =
		paperMatches.length > 0 || aliasRows.length > 0 || contentHits.length > 0;
	const hasCmdResults = visibleCommands.length > 0;

	const placeholder =
		effectiveMode === "commands"
			? t("commandPalette.commandsPlaceholder")
			: t("commandPalette.placeholder");

	const title =
		effectiveMode === "commands"
			? t("commandPalette.commandsTitle")
			: t("commandPalette.title");

	return (
		<CommandDialog
			open={open}
			onOpenChange={onOpenChange}
			className="max-w-xl"
			title={title}
			description={placeholder}
		>
			<Command shouldFilter={false} loop>
				<CommandInput
					value={query}
					onValueChange={setQuery}
					placeholder={placeholder}
				/>
				<CommandList>
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
											onSelect={() => runCommand(cmd)}
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
													<span className="truncate">{p.title || p.id}</span>
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
												<span className="truncate">{candidate.label}</span>
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
			</Command>
		</CommandDialog>
	);
}

function CommandIcon({ id }: { id: string }) {
	const Icon: LucideIcon = id.startsWith("settings.")
		? Settings2
		: id.startsWith("vault.") || id.startsWith("library.")
			? FileText
			: SquareTerminal;
	return <Icon className="text-muted-foreground" />;
}
