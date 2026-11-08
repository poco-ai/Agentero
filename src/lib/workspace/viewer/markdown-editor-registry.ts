/** Per-panel handles; two panes for the same file own separate surfaces. */
type MarkdownEditorHandle = {
	toggleSource: () => void;
	hasPendingSource: () => boolean;
	flushSource: () => Promise<boolean>;
};

const handles = new Map<string, MarkdownEditorHandle>();

export function registerMarkdownEditor(
	tabId: string,
	handle: MarkdownEditorHandle,
) {
	handles.set(tabId, handle);
	return () => {
		if (handles.get(tabId) === handle) handles.delete(tabId);
	};
}

export function markdownEditorFor(tabId: string | null | undefined) {
	return tabId ? handles.get(tabId) : undefined;
}

/** Registered tab ids, in registration order (oldest first). */
export function markdownEditorIds(): string[] {
	return [...handles.keys()];
}

export function flushMarkdownSources() {
	return Promise.all(
		Array.from(handles.values())
			.filter((handle) => handle.hasPendingSource())
			.map((handle) => handle.flushSource()),
	).then((results) => results.every(Boolean));
}
