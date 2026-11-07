// @vitest-environment happy-dom
import { MarkdownPlugin } from "@platejs/markdown";
import { createPlateEditor } from "platejs/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMarkdownPersistence } from "@/components/editor/hooks/use-markdown-persistence";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";

const seed = "# Initial\n";
const path = "/vault/note.md";
let root: ReturnType<typeof createRoot>;
let editor: ReturnType<typeof createPlateEditor>;
let persistence: ReturnType<typeof useMarkdownPersistence>;
let write: (path: string, md: string, last: string) => Promise<boolean>;

function Host() {
	persistence = useMarkdownPersistence({
		editor,
		initialMarkdown: seed,
		filePath: path,
		filePathRef: { current: path },
		onAssetsChangedRef: { current: undefined },
		onPersist: write,
	});
	return null;
}

describe("source mode persistence", () => {
	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		editor = createPlateEditor({ plugins: [MarkdownPlugin] });
		root = createRoot(document.createElement("div"));
		write = vi.fn(async () => true);
		await act(() => root.render(createElement(Host)));
	});

	afterEach(async () => {
		await act(() => root.unmount());
		vi.unstubAllGlobals();
	});

	it("flushes exact edited text after restoring Plate, including frontmatter and empty documents", async () => {
		const raw = "---\r\ntitle: Exact  \r\n---\r\n\r\n*kept as typed*  \n";
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => raw);
			const { body, frontmatter } = splitFrontmatter(raw);
			persistence.endSource(deserializeMarkdownBody(editor, body), frontmatter);
			await persistence.saveNow();
		});
		expect(persistence.frontmatterYaml).toBe("title: Exact  ");
		expect(write).toHaveBeenLastCalledWith(path, raw, seed);
		expect(editor.history.undos).toHaveLength(0);
		await act(async () => {
			persistence.beginSource(raw);
			persistence.updateSource(() => "");
			await persistence.saveNow();
		});
		expect(write).toHaveBeenLastCalledWith(path, "", raw);
	});

	it("keeps the saved baseline on conflict and reloads the source buffer only when told to", async () => {
		vi.mocked(write).mockResolvedValueOnce(false);
		const local = "source  \n";
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => local);
			expect(await persistence.saveNow()).toBe(false);
		});
		expect(persistence.savedRef.current).toBe(seed);
		expect(persistence.serialize()).toBe(local);
		expect(persistence.dirtyRef.current).toBe(true);

		await act(() => {
			persistence.applyExternalMarkdown("# External\n");
		});
		expect(persistence.serialize()).toBe("# External\n");
		expect(persistence.dirtyRef.current).toBe(false);
	});

	it("queues a newer source edit behind an in-flight save", async () => {
		let release = (_ok: boolean) => {};
		vi.mocked(write).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => "first\n");
			const saving = persistence.saveNow();
			persistence.updateSource(() => "second  \n");
			release(true);
			await saving;
		});
		expect(write).toHaveBeenNthCalledWith(1, path, "first\n", seed);
		expect(write).toHaveBeenNthCalledWith(2, path, "second  \n", "first\n");
		expect(persistence.dirtyRef.current).toBe(false);
	});
});
