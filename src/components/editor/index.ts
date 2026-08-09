/**
 * Public surface of the Markdown editor.
 *
 * Everything else under `editor/` is internal: `nodes/` renders Plate elements,
 * `plugins/` wires them into kits, `embeds/` owns the wiki embed subsystem,
 * `toolbar/` and `overlays/` are chrome. Import those only from within `editor/`.
 */
export {
	MarkdownEditor,
	type MarkdownEditorProps,
} from "@/components/editor/markdown-editor";
