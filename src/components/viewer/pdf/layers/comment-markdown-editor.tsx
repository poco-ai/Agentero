/**
 * In-place WYSIWYG Markdown editor for PDF comment cards. The same
 * MarkdownEditorKit as the note editor, so typing "- " grows a bullet,
 * **bold** input rules fire, and the mark shortcuts match the editor
 * defaults (⌘B / ⌘I / ⌘U). Commit points serialize back to Markdown.
 */

import { MarkdownPlugin } from "@platejs/markdown";
import { Plate, usePlateEditor } from "platejs/react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type MutableRefObject,
	useLayoutEffect,
	useMemo,
} from "react";
import { Editor } from "@/components/editor/editor-surface";
import { CommentMarkdownKit } from "@/components/editor/plugins/comment-markdown-kit";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";

export type CommentMarkdownEditorHandle = {
	getMarkdown: () => string;
	focusEnd: () => void;
	blur: () => void;
};

type CommentMarkdownEditorProps = {
	initialValue: string;
	ariaLabel: string;
	placeholder?: string;
	className?: string;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
	onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
	onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
	/** Serialized Markdown after each content change (commit drafts). */
	onChange?: (markdown: string) => void;
	/** Receives the live handle; nulled when the editor is torn down. */
	handleRef?: MutableRefObject<CommentMarkdownEditorHandle | null>;
};

export function CommentMarkdownEditor({
	initialValue,
	ariaLabel,
	placeholder,
	className,
	onKeyDown,
	onBlur,
	onFocus,
	onChange,
	handleRef,
}: CommentMarkdownEditorProps) {
	const plugins = useMemo(() => [...CommentMarkdownKit], []);
	const editor = usePlateEditor({
		plugins,
		value: (currentEditor) =>
			deserializeMarkdownBody(currentEditor, initialValue),
	});
	const handle = useMemo<CommentMarkdownEditorHandle>(
		() => ({
			getMarkdown: () => editor.getApi(MarkdownPlugin).markdown.serialize(),
			focusEnd: () => {
				editor.tf.focus({ at: editor.api.end([]) });
			},
			blur: () => {
				editor.tf.blur();
			},
		}),
		[editor],
	);

	// Publish the handle and park the caret at the end of the note. Focus in a
	// layout effect (before paint) so the editable wins focus against WebKit's
	// queued focusout from the unmounting view body. Do not serialize here: the
	// parent's draft starts as the stored comment, and a mount-time emit would
	// mark an untouched note dirty (serialization normalizes whitespace),
	// which StrictMode's fake unmount turns into a save that closes the
	// editor the moment it opens.
	useLayoutEffect(() => {
		if (handleRef) handleRef.current = handle;
		handle.focusEnd();
		return () => {
			if (handleRef) handleRef.current = null;
		};
	}, [handle, handleRef]);

	return (
		<Plate
			editor={editor}
			onChange={() => {
				onChange?.(handle.getMarkdown());
			}}
		>
			<Editor
				className={className}
				placeholder={placeholder}
				aria-label={ariaLabel}
				onKeyDown={onKeyDown}
				onBlur={onBlur}
				onFocus={onFocus}
			/>
		</Plate>
	);
}
