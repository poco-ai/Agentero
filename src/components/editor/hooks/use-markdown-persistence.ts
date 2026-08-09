"use client";

import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	frontmatterInterior,
	joinFrontmatter,
	splitFrontmatter,
	wrapFrontmatter,
} from "@/lib/markdown/frontmatter";
import {
	collectImageUrlCounts,
	createManagedAssetGc,
} from "@/lib/markdown/image";
import { settleMarkdownSaveAttempt } from "@/lib/markdown/save-state";

const CHANGE_DEBOUNCE_MS = 500;

type UseMarkdownPersistenceOptions = {
	editor: PlateEditor;
	initialMarkdown: string;
	filePath?: string | null;
	readOnly?: boolean;
	onPersist?: (
		path: string,
		markdown: string,
		lastSaved: string,
	) => Promise<boolean>;
	onDirtyChange?: (dirty: boolean) => void;
	/**
	 * Mirrored props owned by the caller: the Plate plugin store is built before
	 * this hook runs, so both it and autosave read the same cells.
	 */
	filePathRef: RefObject<string | null>;
	onAssetsChangedRef: RefObject<(() => void) | undefined>;
};

export type MarkdownPersistence = {
	/** YAML interior for the Properties panel (no `---` fences). */
	frontmatterYaml: string;
	onFrontmatterChange: (interior: string) => void;
	/** The whole document as Markdown, frontmatter re-attached. */
	serialize: () => string;
	/** Debounced autosave; also reconciles `./assets/` when the debounce fires. */
	noteDocumentChanged: () => void;
	/** Flush the pending debounce and write immediately. */
	saveNow: () => void;
	/** Content currently believed to be on disk. */
	savedRef: RefObject<string>;
	dirtyRef: RefObject<boolean>;
};

/**
 * Autosave, dirty tracking and managed `./assets/` GC for one open file.
 *
 * The debounce, the in-flight/queued pair and the unmount flush exist so a fast
 * file switch still lands the last edit on the file it was typed into.
 */
export function useMarkdownPersistence({
	editor,
	initialMarkdown,
	filePath,
	readOnly,
	onPersist,
	onDirtyChange,
	filePathRef,
	onAssetsChangedRef,
}: UseMarkdownPersistenceOptions): MarkdownPersistence {
	const frontmatterRef = useRef("");
	const [frontmatterYaml, setFrontmatterYaml] = useState(() => {
		const { frontmatter } = splitFrontmatter(initialMarkdown);
		// Seed ref before first serialize / persist can run.
		frontmatterRef.current = frontmatter;
		return frontmatterInterior(frontmatter);
	});
	const savedRef = useRef(initialMarkdown);
	const readyRef = useRef(false);
	/**
	 * Tracks the dirty flag so `onDirtyChange` fires only on a real transition.
	 * Without this, every keystroke would call it and re-render the whole app
	 * (the tab-bar unsaved indicator), which made editing laggy on large notes.
	 */
	const dirtyRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const persistInFlightRef = useRef<Promise<void> | null>(null);
	const persistQueuedRef = useRef(false);
	/** Image URL ref-counts; used to GC `./assets/` when an image node is removed. */
	const imageCountsRef = useRef<Map<string, number> | null>(null);
	/**
	 * Debounced asset GC so cut → paste / undo still finds the file.
	 * Immediate delete used to leave a live `./assets/…` node with a missing file.
	 */
	const assetGcRef = useRef(
		createManagedAssetGc({
			onDeleted: () => {
				onAssetsChangedRef.current?.();
			},
		}),
	);

	const serialize = useCallback(() => {
		const body = editor.getApi(MarkdownPlugin).markdown.serialize();
		return joinFrontmatter(frontmatterRef.current, body);
	}, [editor]);

	const setDirty = useCallback(
		(dirty: boolean) => {
			if (dirtyRef.current === dirty) return;
			dirtyRef.current = dirty;
			onDirtyChange?.(dirty);
		},
		[onDirtyChange],
	);

	const persist = useCallback(() => {
		if (readOnly || !filePath || !onPersist) return;
		persistQueuedRef.current = true;
		if (persistInFlightRef.current) return;

		const task = (async () => {
			while (persistQueuedRef.current) {
				persistQueuedRef.current = false;
				const markdown = serialize();
				const lastSaved = savedRef.current;
				if (markdown === lastSaved) {
					setDirty(false);
					continue;
				}
				if (!markdown.trim() && lastSaved.trim()) return;

				let persisted = false;
				try {
					persisted = await onPersist(filePath, markdown, lastSaved);
				} catch {
					// The App owns user-facing persistence errors. Keep this editor
					// dirty and retain the last disk-confirmed snapshot.
				}
				const settlement = settleMarkdownSaveAttempt({
					attemptedMarkdown: markdown,
					currentMarkdown: serialize(),
					lastSaved,
					persisted,
				});
				savedRef.current = settlement.savedMarkdown;
				setDirty(settlement.dirty);
				if (!persisted) {
					persistQueuedRef.current = false;
					return;
				}
				if (settlement.retryLatest) persistQueuedRef.current = true;
			}
		})();
		persistInFlightRef.current = task;
		const finish = () => {
			if (persistInFlightRef.current === task) {
				persistInFlightRef.current = null;
				if (persistQueuedRef.current) persistRef.current();
			}
		};
		void task.then(finish, finish);
	}, [filePath, onPersist, readOnly, serialize, setDirty]);

	// Latest persist closure, for the unmount flush (captures this file's path).
	const persistRef = useRef(persist);
	persistRef.current = persist;

	/**
	 * Diff `./assets/` ref-counts and hand the delta to the GC.
	 *
	 * `collectImageUrlCounts` walks every node, so this runs once per debounce
	 * window rather than per keystroke. The GC is itself debounced, so deferring
	 * the diff does not change when files actually get deleted.
	 */
	const reconcileAssets = useCallback(() => {
		const nextCounts = collectImageUrlCounts(editor.children);
		const prevCounts = imageCountsRef.current;
		imageCountsRef.current = nextCounts;
		const mdPath = filePathRef.current;
		// Skip bookkeeping for image-free notes — the common case.
		if (mdPath && prevCounts && (prevCounts.size || nextCounts.size)) {
			assetGcRef.current.observe(mdPath, prevCounts, nextCounts);
		}
	}, [editor, filePathRef]);
	const reconcileAssetsRef = useRef(reconcileAssets);
	reconcileAssetsRef.current = reconcileAssets;

	// Mark ready after the initial normalization pass so opening a file never saves.
	// Seed image URL counts so we only GC assets removed after open.
	// On unmount, flush pending edit + deferred asset GC for this file.
	useEffect(() => {
		readyRef.current = true;
		imageCountsRef.current = collectImageUrlCounts(editor.children);
		const assetGc = assetGcRef.current;
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
				reconcileAssetsRef.current();
				persistRef.current();
			}
			void assetGc.flush();
		};
	}, [editor]);

	const schedulePersist = useCallback(() => {
		if (readOnly || !readyRef.current) return;
		if (!dirtyRef.current) {
			setDirty(true);
		}
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			reconcileAssetsRef.current();
			persistRef.current();
		}, CHANGE_DEBOUNCE_MS);
	}, [readOnly, setDirty]);

	const onFrontmatterChange = useCallback(
		(interior: string) => {
			setFrontmatterYaml(interior);
			frontmatterRef.current = wrapFrontmatter(interior);
			schedulePersist();
		},
		[schedulePersist],
	);

	const saveNow = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		reconcileAssetsRef.current();
		persistRef.current();
	}, []);

	return {
		frontmatterYaml,
		onFrontmatterChange,
		serialize,
		noteDocumentChanged: schedulePersist,
		saveNow,
		savedRef,
		dirtyRef,
	};
}
