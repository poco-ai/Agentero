import { EditorState } from "@codemirror/state";
import { latexLanguage } from "codemirror-lang-latex";
import { type BibEntry, parseBibEntries } from "@/lib/bibtex/parse";
import { events } from "@/lib/core/bindings";
import { dirnameOf, joinPath, normalizePath } from "@/lib/core/path";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { texBuildOptions, texSettingsStore } from "@/lib/tex/config";
import { inspectLatexProject, type LatexProjectInfo } from "@/lib/tex/host";
import {
	resolveTexInputPath,
	type TexOutlineItem,
	texOutlineFromTree,
} from "@/lib/tex/outline";
import { parseTexBibitems } from "@/lib/tex/source";
import { readVaultFile } from "@/lib/vault/fs";
import { vaultStore } from "@/lib/vault/store";
import { resolveTexRoot } from "@/lib/workspace/tex-compile";

export type TexLabel = {
	key: string;
	path: string;
	line: number;
	preview: string;
};
export type TexCitation = BibEntry & { path: string; line: number };
export type TexProjectIndex = LatexProjectInfo & {
	documents: Map<string, string>;
	labels: TexLabel[];
	citations: TexCitation[];
	outline: TexOutlineItem[];
};
const buffers = new Map<string, () => string>();
let bufferVersion = 0;
const bufferListeners = new Set<() => void>();

function touchTexBuffers(): void {
	bufferVersion += 1;
	for (const listener of bufferListeners) listener();
}

/** Re-read mounted TeX buffers after an edit. The snapshot is the version. */
export function subscribeTexBuffers(listener: () => void): () => void {
	bufferListeners.add(listener);
	return () => {
		bufferListeners.delete(listener);
	};
}

export function texBufferVersion(): number {
	return bufferVersion;
}

export function readTexBuffers(): ReadonlyMap<string, string> {
	const documents = new Map<string, string>();
	for (const [path, read] of buffers) {
		try {
			documents.set(path, read());
		} catch {
			// A buffer can unmount between the version bump and this read.
		}
	}
	return documents;
}
const cache = new Map<
	string,
	{ at: number; promise: Promise<TexProjectIndex> }
>();
const subscribers = new Set<(paths: readonly string[]) => void>();
let unlistenFiles: (() => void) | undefined;

/** Save/watcher notifications refresh graph discovery and mounted semantic views. */
export function notifyTexProjectFilesChanged(paths: readonly string[]): void {
	const sources = paths.filter((path) => /\.(?:tex|bib|sty|cls)$/i.test(path));
	if (!sources.length) return;
	invalidateTexProjectIndex();
	for (const subscriber of subscribers) subscriber(sources);
}

export function subscribeTexProjectChanges(
	subscriber: (paths: readonly string[]) => void,
): () => void {
	subscribers.add(subscriber);
	unlistenFiles ??= listenEventSafe(events.vaultFileChanged, ({ paths }) =>
		notifyTexProjectFilesChanged(paths),
	);
	return () => {
		subscribers.delete(subscriber);
		if (!subscribers.size) {
			unlistenFiles?.();
			unlistenFiles = undefined;
		}
	};
}
texSettingsStore.subscribe((state, previous) => {
	if (state.roots !== previous.roots || state.projects !== previous.projects)
		cache.clear();
});

export function registerTexProjectBuffer(
	path: string,
	read: () => string,
): () => void {
	const key = normalizePath(path);
	buffers.set(key, read);
	invalidateTexProjectIndex();
	return () => {
		if (buffers.get(key) === read) buffers.delete(key);
		invalidateTexProjectIndex();
	};
}

export function invalidateTexProjectIndex(): void {
	cache.clear();
	touchTexBuffers();
}

/** Normalize relative segments while retaining Windows/UNC separator style. */
export function texPathKey(path: string): string {
	const normalized = normalizePath(path);
	const prefix = normalized.startsWith("//")
		? "//"
		: normalized.startsWith("/")
			? "/"
			: "";
	const parts: string[] = [];
	for (const part of normalized.slice(prefix.length).split("/")) {
		if (!part || part === ".") continue;
		if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
		else if (part !== ".." || !prefix) parts.push(part);
	}
	return prefix + parts.join("/");
}

function lineNumber(source: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i += 1)
		if (source.charCodeAt(i) === 10) line += 1;
	return line;
}

/** Pure project index builder shared by completion, navigation and outline. */
export function buildTexProjectIndex(
	info: LatexProjectInfo,
	documents: Map<string, string>,
): TexProjectIndex {
	const docs = new Map(
		[...documents].map(([path, content]) => [texPathKey(path), content]),
	);
	const labels: TexLabel[] = [];
	const citations: TexCitation[] = [];
	const outlines = new Map<string, TexOutlineItem[]>();
	for (const path of info.texFiles) {
		const source = docs.get(texPathKey(path));
		if (source === undefined) continue;
		const doc = EditorState.create({ doc: source }).doc;
		const items = texOutlineFromTree(
			latexLanguage.parser.parse(source).topNode,
			doc,
		).map((item) => ({ ...item, path, id: `${texPathKey(path)}:${item.id}` }));
		outlines.set(texPathKey(path), items);
		for (const entry of parseTexBibitems(source))
			citations.push({ ...entry, path, line: lineNumber(source, entry.from) });
		for (const item of items) {
			if (item.kind !== "label") continue;
			const from = doc.line(Math.max(1, item.line - 2)).from;
			const to = doc.line(Math.min(doc.lines, item.line + 3)).to;
			labels.push({
				key: item.title,
				path,
				line: item.line,
				preview: source.slice(from, to),
			});
		}
	}
	for (const path of info.bibFiles) {
		const source = docs.get(texPathKey(path));
		if (source === undefined) continue;
		for (const entry of parseBibEntries(source))
			citations.push({ ...entry, path, line: lineNumber(source, entry.from) });
	}
	const outline: TexOutlineItem[] = [];
	const visit = (path: string, indent: number, ancestry: Set<string>) => {
		const key = texPathKey(path);
		if (ancestry.has(key)) return;
		const chain = new Set(ancestry).add(key);
		for (const item of outlines.get(key) ?? []) {
			outline.push({ ...item, indent: item.indent + indent });
			if (item.kind !== "file" || !item.fileArg) continue;
			const relative = resolveTexInputPath(path, item.fileArg);
			const rootRelative = joinPath(
				dirnameOf(info.rootPath),
				/\.tex$/i.test(item.fileArg) ? item.fileArg : `${item.fileArg}.tex`,
			);
			const target = outlines.has(texPathKey(rootRelative))
				? rootRelative
				: relative;
			visit(target, item.indent + indent + 1, chain);
		}
	};
	visit(info.rootPath, 0, new Set());
	return { ...info, documents: docs, labels, citations, outline };
}

export function loadTexProjectIndex(path: string): Promise<TexProjectIndex> {
	const key = normalizePath(path);
	const existing = cache.get(key);
	if (existing && Date.now() - existing.at < 1500) return existing.promise;
	const promise = (async () => {
		const rootPath = await resolveTexRoot(path);
		const info = await inspectLatexProject(
			path,
			vaultStore.getState().vaultPath ?? "",
			rootPath,
			texBuildOptions(rootPath),
		);
		const docs = await Promise.all(
			[...new Set([...info.texFiles, ...info.bibFiles])].map(async (file) => {
				const buffer = buffers.get(normalizePath(file));
				try {
					return [file, buffer ? buffer() : await readVaultFile(file)] as const;
				} catch {
					return [file, ""] as const;
				}
			}),
		);
		return buildTexProjectIndex(info, new Map(docs));
	})();
	cache.set(key, { at: Date.now(), promise });
	void promise.catch(() => {
		if (cache.get(key)?.promise === promise) cache.delete(key);
	});
	return promise;
}
