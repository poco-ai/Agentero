"use client";

import {
	ExternalLink,
	FileText,
	FileType2,
	Highlighter,
	ImageIcon,
	ScanSearch,
	TextQuote,
} from "lucide-react";
import { PlateElement, type PlateElementProps } from "platejs/react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownDoc } from "@/components/editor/markdown-doc-context";
import { useMarkdownExportMode } from "@/components/editor/markdown-export-mode-context";
import type { WikiSlateNode } from "@/components/editor/plugins/wikilink-model";
import { WikiAnnotationEmbed } from "@/components/editor/wiki-annotation-embed";
import {
	MAX_WIKI_EMBED_DEPTH,
	useWikiEmbedAncestry,
	WikiEmbedAncestryProvider,
} from "@/components/editor/wiki-embed-context";
import { useWikiEmbedProjection } from "@/components/editor/wiki-embed-projection-context";
import { cn } from "@/lib/core/utils";
import type { AnnotationRefKind } from "@/lib/pdf/annotation-ref";
import { joinVaultPath } from "@/lib/vault";
import {
	type ResolvedLink,
	readWikiEmbed,
	resolveWikiTarget,
	splitAnnotationSugar,
	type WikiEmbedResponse,
} from "@/lib/wiki";
import { useWikiNav } from "@/lib/wiki/nav-context";
import { subscribeWikiEmbedTarget } from "@/lib/wiki-embed-refresh";

const WikiAttachmentEmbed = lazy(async () => {
	const module = await import("@/components/editor/wiki-attachment-embed");
	return { default: module.WikiAttachmentEmbed };
});

type EmbedLoadState =
	| { kind: "loading" }
	| { kind: "ready"; response: WikiEmbedResponse; key: string }
	| {
			kind:
				| "missing"
				| "ambiguous"
				| "invalidFragment"
				| "unsupported"
				| "error";
			response?: WikiEmbedResponse;
			detail?: string;
	  };

type CachedEmbedLoad = {
	requestKey: string | null;
	state: EmbedLoadState;
};

const EMBED_CACHE_LIMIT = 128;
const embedStateCache = new Map<string, EmbedLoadState>();
const embedRequestCache = new Map<string, Promise<EmbedLoadState>>();

function embedRequestKey(
	vaultPath: string | null | undefined,
	sourcePath: string | null,
	target: string,
	targetRevision: number,
): string | null {
	if (!vaultPath || !sourcePath) return null;
	return JSON.stringify([vaultPath, sourcePath, target, targetRevision]);
}

/** Request key without revision — same embed identity across marks/file reloads. */
function embedIdentityKey(
	vaultPath: string | null | undefined,
	sourcePath: string | null,
	target: string,
): string | null {
	if (!vaultPath || !sourcePath) return null;
	return JSON.stringify([vaultPath, sourcePath, target]);
}

function cachedEmbedState(key: string): EmbedLoadState | undefined {
	return embedStateCache.get(key);
}

function retainEmbedState(key: string, state: EmbedLoadState): void {
	// Never cache terminal "not found" results: cold-start races (index not
	// ready yet) must be allowed to succeed on the next mount/retry instead of
	// permanently showing "找不到嵌入的笔记".
	if (
		state.kind === "error" ||
		state.kind === "loading" ||
		state.kind === "missing" ||
		state.kind === "ambiguous"
	) {
		return;
	}
	embedStateCache.delete(key);
	embedStateCache.set(key, state);
	while (embedStateCache.size > EMBED_CACHE_LIMIT) {
		const oldest = embedStateCache.keys().next().value;
		if (typeof oldest !== "string") break;
		embedStateCache.delete(oldest);
	}
}

function fragmentKey(link: ResolvedLink): string {
	const fragment = link.occurrence.fragment;
	if (!fragment) return "";
	if (fragment.kind === "block") return `#^${fragment.id}`;
	if (fragment.kind === "annotation") return `@${fragment.id}`;
	return `#${fragment.path.join("#")}`;
}

function embedKey(link: ResolvedLink): string {
	return `${link.targetPath ?? link.occurrence.targetRaw}${fragmentKey(link)}`;
}

function stateFromResponse(response: WikiEmbedResponse): EmbedLoadState {
	if (response.link.status !== "resolved") {
		return { kind: response.link.status, response };
	}
	switch (response.contentKind) {
		case "markdown":
			return typeof response.content === "string"
				? { kind: "ready", response, key: embedKey(response.link) }
				: { kind: "unsupported", response };
		case "image":
		case "pdf":
		case "annotation":
			return { kind: "ready", response, key: embedKey(response.link) };
		default:
			return { kind: "unsupported", response };
	}
}

/**
 * When Host resolve returns `missing` for a `path@annotId` token (cold-start
 * race, escaped id, or path-like relative mishap), recover via client sugar
 * parse + vault file list so annotation embeds still open.
 */
function recoverAnnotationEmbed(
	target: string,
	files: string[],
	sourcePath: string,
): WikiEmbedResponse | null {
	const sugar = splitAnnotationSugar(target);
	if (!sugar) return null;
	const targetPath =
		resolveWikiTarget(sugar.target, files) ||
		// same-note form: resolve to the source file when listed
		(sugar.target === ""
			? files.find(
					(f) =>
						f.replace(/\\/g, "/").toLowerCase() ===
						sourcePath.replace(/\\/g, "/").toLowerCase(),
				) || null
			: null);
	if (!targetPath && sugar.target !== "") return null;
	const path =
		targetPath ||
		sourcePath
			.replace(/\\/g, "/")
			.replace(/^.*\/(?=papers\/|notes\/)/i, "") // best-effort vault-rel
			.replace(/^\//, "");
	if (!path) return null;
	return {
		link: {
			occurrence: {
				source: sourcePath,
				targetRaw: sugar.target,
				syntax: "wikilink",
				embed: true,
				fragment: { kind: "annotation", id: sugar.id },
				sourceRange: { start: 0, end: 0 },
				line: 1,
			},
			status: "resolved",
			targetPath: path,
		},
		contentKind: "annotation",
	};
}

function loadEmbedState(
	key: string,
	vaultPath: string,
	sourcePath: string,
	target: string,
	vaultFiles: string[] = [],
): Promise<EmbedLoadState> {
	const cached = cachedEmbedState(key);
	if (cached) return Promise.resolve(cached);
	const pending = embedRequestCache.get(key);
	if (pending) return pending;

	const request = readWikiEmbed(vaultPath, sourcePath, target)
		.then((response) => {
			if (response.link.status === "missing" && vaultFiles.length) {
				const recovered = recoverAnnotationEmbed(
					target,
					vaultFiles,
					sourcePath,
				);
				if (recovered) return stateFromResponse(recovered);
			}
			return stateFromResponse(response);
		})
		.catch(
			(error): EmbedLoadState => ({
				kind: "error",
				detail: error instanceof Error ? error.message : String(error),
			}),
		)
		.then((state) => {
			retainEmbedState(key, state);
			return state;
		})
		.finally(() => {
			embedRequestCache.delete(key);
		});
	embedRequestCache.set(key, request);
	return request;
}

function EmbedStatus({ message }: { message: string }) {
	return (
		<span className="block px-4 py-3 text-muted-foreground text-sm">
			{message}
		</span>
	);
}

type EmbedChromeKind =
	| "markdown"
	| "image"
	| "pdf"
	/** Text highlight / note on PDF. */
	| "annotation-highlight"
	/** Visual crop / region mark. */
	| "annotation-visual"
	/** Annotation token known, subtype not loaded yet. */
	| "annotation"
	| "status";

function embedChromeKind(
	state: EmbedLoadState,
	heading: string | null | undefined,
	annotationKind: AnnotationRefKind | null,
): EmbedChromeKind {
	// Prefer resolved subtype once the body has loaded the mark.
	if (annotationKind === "visual" || annotationKind === "agent-trace")
		return "annotation-visual";
	if (annotationKind === "highlight") return "annotation-highlight";

	if (state.kind === "ready") {
		const kind = state.response.contentKind;
		if (kind === "markdown" || kind === "image" || kind === "pdf") {
			return kind;
		}
		if (kind === "annotation") {
			// Subtype pending → highlighter (划词), not magnifier (视觉).
			return "annotation-highlight";
		}
	}
	// Token `…@id` is known from the heading field before Host resolves.
	if (heading?.startsWith("@")) return "annotation-highlight";
	return "status";
}

function EmbedTypeIcon({ kind }: { kind: EmbedChromeKind }) {
	const className = "size-3.5 shrink-0 text-muted-foreground";
	switch (kind) {
		case "annotation-visual":
			return <ScanSearch className={className} aria-hidden />;
		case "annotation-highlight":
		case "annotation":
			// 划词高亮 / 文字批注 — not the visual magnifier.
			return <Highlighter className={className} aria-hidden />;
		case "image":
			return <ImageIcon className={className} aria-hidden />;
		case "pdf":
			return <FileType2 className={className} aria-hidden />;
		case "markdown":
			return <FileText className={className} aria-hidden />;
		default:
			return <TextQuote className={className} aria-hidden />;
	}
}

export function WikiEmbedElement({
	editing,
	...props
}: PlateElementProps & { editing: boolean }) {
	const { t } = useTranslation("editor");
	const element = props.element as unknown as WikiSlateNode;
	const wikiNav = useWikiNav();
	const markdownDoc = useMarkdownDoc();
	const exportMode = useMarkdownExportMode();
	const ancestry = useWikiEmbedAncestry();
	const EmbeddedMarkdownProjection = useWikiEmbedProjection();
	const expandEmbeds = exportMode?.expandEmbeds === true;
	const hideChromeActions = exportMode?.hideChromeActions === true;

	const target = element.value ?? "";
	const targetWithFragment = element.heading
		? element.heading.startsWith("@")
			? target
				? `${target}${element.heading}`
				: element.heading
			: target
				? `${target}#${element.heading}`
				: `#${element.heading}`
		: target;
	const [targetRevision, setTargetRevision] = useState(0);
	/**
	 * highlight vs agent-trace for the header icon. Keyed by embed token so a
	 * subtype from a previous link never sticks after the token changes
	 * (avoids a reset-only useEffect that trips exhaustive-deps lint).
	 */
	const [annotationMeta, setAnnotationMeta] = useState<{
		token: string;
		kind: AnnotationRefKind;
	} | null>(null);
	const annotationKind =
		annotationMeta?.token === targetWithFragment ? annotationMeta.kind : null;
	const onAnnotationKind = useCallback(
		(kind: AnnotationRefKind) => {
			setAnnotationMeta({ token: targetWithFragment, kind });
		},
		[targetWithFragment],
	);
	const requestKey = embedRequestKey(
		wikiNav?.vaultPath,
		markdownDoc.filePath,
		targetWithFragment,
		targetRevision,
	);
	const [load, setLoad] = useState<CachedEmbedLoad>(() => ({
		requestKey,
		state: requestKey
			? (cachedEmbedState(requestKey) ?? { kind: "loading" })
			: {
					kind: "error",
				},
	}));
	const fallbackState =
		load.requestKey === requestKey || !requestKey
			? undefined
			: cachedEmbedState(requestKey);
	const state =
		load.requestKey === requestKey
			? load.state
			: requestKey
				? (fallbackState ?? { kind: "loading" })
				: { kind: "error" as const };

	useEffect(() => {
		const vaultPath = wikiNav?.vaultPath;
		const sourcePath = markdownDoc.filePath;
		if (!vaultPath || !sourcePath || !requestKey) {
			setLoad({ requestKey: null, state: { kind: "error" } });
			return;
		}

		const cached = cachedEmbedState(requestKey);
		if (cached) {
			setLoad((previous) =>
				previous.requestKey === requestKey && previous.state === cached
					? previous
					: { requestKey, state: cached },
			);
			return;
		}

		let cancelled = false;
		// Stale-while-revalidate only when the embed identity is unchanged and
		// only the revision suffix advanced (target file / marks reloaded).
		// Switching to a different ![[target]] still shows loading.
		const identity = embedIdentityKey(
			vaultPath,
			sourcePath,
			targetWithFragment,
		);
		setLoad((previous) => {
			if (previous.requestKey === requestKey) return previous;
			const previousIdentity =
				previous.requestKey && previous.requestKey.length > 2
					? (() => {
							try {
								const parsed = JSON.parse(previous.requestKey) as unknown[];
								if (!Array.isArray(parsed) || parsed.length < 3) return null;
								return JSON.stringify(parsed.slice(0, 3));
							} catch {
								return null;
							}
						})()
					: null;
			const keepProjection =
				identity &&
				previousIdentity === identity &&
				previous.state.kind === "ready";
			return {
				requestKey,
				state: keepProjection ? previous.state : { kind: "loading" },
			};
		});
		void loadEmbedState(
			requestKey,
			vaultPath,
			sourcePath,
			targetWithFragment,
			wikiNav?.mdFiles ?? [],
		).then((nextState) => {
			if (!cancelled) setLoad({ requestKey, state: nextState });
		});
		return () => {
			cancelled = true;
		};
	}, [
		markdownDoc.filePath,
		requestKey,
		targetWithFragment,
		wikiNav?.mdFiles,
		wikiNav?.vaultPath,
	]);

	const resolvedLink = "response" in state ? state.response?.link : undefined;
	const navigate = useCallback(() => {
		if (resolvedLink?.status !== "resolved" || !resolvedLink.targetPath) {
			return;
		}
		wikiNav?.onWikiNavigate({
			targetRaw: resolvedLink.occurrence.targetRaw,
			path: resolvedLink.targetPath,
			status: resolvedLink.status,
			fragment: resolvedLink.occurrence.fragment,
		});
	}, [resolvedLink, wikiNav]);

	const presentation = useMemo(() => {
		if (state.kind !== "ready") return state;
		if (ancestry.includes(state.key)) {
			return { kind: "cycle" as const };
		}
		if (ancestry.length >= MAX_WIKI_EMBED_DEPTH) {
			return { kind: "depth" as const };
		}
		return state;
	}, [ancestry, state]);

	const imageSizeAlias =
		state.kind === "ready" &&
		state.response.contentKind === "image" &&
		/^([1-9]\d*)(?:x([1-9]\d*))?$/i.test(element.alias?.trim() ?? "");
	const sourceLabel =
		(imageSizeAlias ? "" : element.alias) ||
		targetWithFragment ||
		resolvedLink?.targetPath ||
		"";
	const absoluteTarget =
		state.kind === "ready" &&
		wikiNav?.vaultPath &&
		state.response.link.targetPath
			? joinVaultPath(wikiNav.vaultPath, state.response.link.targetPath)
			: "";

	const isAnnotationEmbed =
		state.kind === "ready" && state.response.contentKind === "annotation";
	const chromeKind = embedChromeKind(state, element.heading, annotationKind);

	// Markdown/image/PDF embeds refresh when their resolved target file changes.
	// Annotation bodies live under paper marks/, not NOTES.md — subscribing to
	// absoluteTarget (often the hosting NOTES) made every autosave flash cards.
	// Mark-path refresh is owned by WikiAnnotationEmbed itself.
	useEffect(() => {
		if (!absoluteTarget || isAnnotationEmbed) return;
		return subscribeWikiEmbedTarget(absoluteTarget, () => {
			setTargetRevision((revision) => revision + 1);
		});
	}, [absoluteTarget, isAnnotationEmbed]);

	return (
		<PlateElement
			{...props}
			as="span"
			className={cn(
				"relative max-w-full align-top",
				editing ? "inline text-foreground" : "my-2 block w-full",
			)}
			attributes={{
				...props.attributes,
				"data-wiki-embed": presentation.kind,
				"data-wiki-source": editing ? "embed" : undefined,
			}}
		>
			<span
				contentEditable={false}
				className={cn(
					"group/embed block rounded-md border border-border bg-muted/20 shadow-sm",
					expandEmbeds
						? "max-h-none overflow-visible"
						: "max-h-96 overflow-auto",
					presentation.kind !== "ready" && "border-dashed",
					editing && "hidden",
				)}
			>
				{/* Shared chrome: type icon + title · open source on the right */}
				<span
					className={cn(
						"z-10 flex items-center gap-2 border-border border-b bg-background/95 px-3 py-1.5 backdrop-blur",
						expandEmbeds ? "relative" : "sticky top-0",
					)}
				>
					<EmbedTypeIcon kind={chromeKind} />
					<span className="min-w-0 flex-1 truncate font-medium text-foreground/90 text-xs">
						{sourceLabel || t("embed.untitled")}
					</span>
					{!hideChromeActions && resolvedLink?.status === "resolved" ? (
						<button
							type="button"
							className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label={t("embed.openSource", { target: sourceLabel })}
							title={t("embed.openSource", { target: sourceLabel })}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								navigate();
							}}
						>
							<ExternalLink className="size-3.5" aria-hidden />
						</button>
					) : null}
				</span>

				{presentation.kind === "loading" ? (
					<EmbedStatus message={t("embed.loading")} />
				) : presentation.kind === "ready" ? (
					<Suspense fallback={<EmbedStatus message={t("embed.loading")} />}>
						{presentation.response.contentKind === "markdown" &&
						EmbeddedMarkdownProjection ? (
							<WikiEmbedAncestryProvider
								ancestry={[...ancestry, presentation.key]}
							>
								<EmbeddedMarkdownProjection
									key={`${presentation.key}:${targetRevision}`}
									markdown={presentation.response.content ?? ""}
									filePath={absoluteTarget}
								/>
							</WikiEmbedAncestryProvider>
						) : presentation.response.contentKind === "image" ||
							presentation.response.contentKind === "pdf" ? (
							<WikiAttachmentEmbed
								kind={presentation.response.contentKind}
								absoluteTarget={absoluteTarget}
								targetPath={presentation.response.link.targetPath ?? target}
								revision={targetRevision}
								imageSize={element.alias}
							/>
						) : presentation.response.contentKind === "annotation" &&
							wikiNav?.vaultPath &&
							presentation.response.link.targetPath &&
							presentation.response.link.occurrence.fragment?.kind ===
								"annotation" ? (
							// Body-only: title/icon + jump live in the shared header above
							// (body is not click-to-open, same as markdown embeds).
							<WikiAnnotationEmbed
								vaultPath={wikiNav.vaultPath}
								targetPath={presentation.response.link.targetPath}
								annotationId={presentation.response.link.occurrence.fragment.id}
								onResolvedKind={onAnnotationKind}
							/>
						) : (
							<EmbedStatus message={t("embed.unsupported")} />
						)}
					</Suspense>
				) : (
					<EmbedStatus
						message={t(
							presentation.kind === "invalidFragment"
								? "embed.invalidFragment"
								: `embed.${presentation.kind}`,
						)}
					/>
				)}
			</span>
			<span
				aria-hidden={editing ? undefined : true}
				className={
					editing
						? undefined
						: "pointer-events-none absolute size-px overflow-hidden opacity-0"
				}
			>
				{props.children}
			</span>
		</PlateElement>
	);
}
