import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
	Bold,
	Code,
	Heading1,
	Heading2,
	Heading3,
	Highlighter,
	ImageIcon,
	Italic,
	List,
	ListOrdered,
	ListTodo,
	Loader2,
	type LucideIcon,
	Strikethrough,
	TextQuote,
	Underline,
} from "lucide-react";
import {
	type MouseEvent as ReactMouseEvent,
	type RefObject,
	useCallback,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { copyFileToMarkdownAssets, pickImageFiles } from "@/lib/markdown/image";
import type { MarkdownSourceFormat } from "@/lib/markdown/source-format";
import { sourceFormatTransaction } from "@/lib/markdown/source-format";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import { MarkdownPaperNotesButton } from "./markdown-toolbar";
import {
	ResponsiveFixedToolbar,
	type ToolbarAction,
} from "./responsive-toolbar";

type SourceActionSpec = {
	format: MarkdownSourceFormat;
	icon: LucideIcon;
	label: string;
	group: number;
	shortcut?: string;
};

/**
 * Source-mode formatting toolbar. Actions edit the CodeMirror document through
 * the same Markdown commands as the source keymap, so toolbar clicks and
 * shortcuts stay in sync.
 */
export function MarkdownSourceToolbar({
	viewRef,
}: {
	viewRef: RefObject<EditorView | null>;
}) {
	const { t } = useTranslation("editor");
	const { filePath, onAssetsChanged } = useMarkdownDoc();
	const [imageBusy, setImageBusy] = useState(false);

	const runFormat = useCallback(
		(format: MarkdownSourceFormat) => {
			const view = viewRef.current;
			if (!view) return;
			const transaction = sourceFormatTransaction(view.state, format);
			if (!transaction) return;
			view.dispatch({ ...transaction, scrollIntoView: true });
			view.focus();
		},
		[viewRef],
	);

	const keepSourceFocus = useCallback((event: ReactMouseEvent) => {
		event.preventDefault();
	}, []);

	const insertImage = useCallback(async () => {
		const view = viewRef.current;
		if (!view || imageBusy) return;
		if (!filePath) {
			notifyError(t("image.noFile"));
			return;
		}
		const { from, to } = view.state.selection.main;
		setImageBusy(true);
		try {
			const paths = await pickImageFiles();
			if (!paths.length) return;
			const images: string[] = [];
			for (const path of paths) {
				const rel = await copyFileToMarkdownAssets(filePath, path);
				images.push(`![](${rel})`);
			}
			const insert = images.join("\n");
			view.dispatch({
				changes: { from, to, insert },
				selection: EditorSelection.cursor(from + insert.length),
				scrollIntoView: true,
			});
			view.focus();
			onAssetsChanged?.();
		} catch (error) {
			notifyError(errorMessage(error));
		} finally {
			setImageBusy(false);
		}
	}, [filePath, imageBusy, onAssetsChanged, t, viewRef]);

	const shortcuts: Partial<Record<MarkdownSourceFormat, string>> = {
		bold: formatModShortcut("b"),
		italic: formatModShortcut("i"),
		underline: formatModShortcut("u"),
		strikethrough: formatModShortcut("x", { shift: true }),
	};

	const specs: SourceActionSpec[] = [
		{
			format: "heading1",
			icon: Heading1,
			label: t("toolbar.h1"),
			group: 0,
		},
		{
			format: "heading2",
			icon: Heading2,
			label: t("toolbar.h2"),
			group: 0,
		},
		{
			format: "heading3",
			icon: Heading3,
			label: t("toolbar.h3"),
			group: 0,
		},
		{
			format: "quote",
			icon: TextQuote,
			label: t("toolbar.quote"),
			group: 0,
		},
		{
			format: "bold",
			icon: Bold,
			label: t("toolbar.bold"),
			group: 1,
			shortcut: shortcuts.bold,
		},
		{
			format: "italic",
			icon: Italic,
			label: t("toolbar.italic"),
			group: 1,
			shortcut: shortcuts.italic,
		},
		{
			format: "underline",
			icon: Underline,
			label: t("toolbar.underline"),
			group: 1,
			shortcut: shortcuts.underline,
		},
		{
			format: "strikethrough",
			icon: Strikethrough,
			label: t("toolbar.strikethrough"),
			group: 1,
			shortcut: shortcuts.strikethrough,
		},
		{ format: "code", icon: Code, label: t("toolbar.code"), group: 1 },
		{
			format: "highlight",
			icon: Highlighter,
			label: t("toolbar.highlight"),
			group: 1,
		},
		{
			format: "bulletList",
			icon: List,
			label: t("toolbar.bulletedList"),
			group: 2,
		},
		{
			format: "orderedList",
			icon: ListOrdered,
			label: t("toolbar.numberedList"),
			group: 2,
		},
		{
			format: "todoList",
			icon: ListTodo,
			label: t("toolbar.todoList"),
			group: 2,
		},
	];

	const actions: ToolbarAction[] = specs.map(
		({ format, icon, label, group, shortcut }) => {
			const Icon = icon;
			return {
				id: format,
				icon: <Icon />,
				label: shortcut ? `${label} (${shortcut})` : label,
				group,
				onClick: () => runFormat(format),
				onMouseDown: keepSourceFocus,
			};
		},
	);

	actions.push({
		id: "image",
		icon: imageBusy ? <Loader2 className="animate-spin" /> : <ImageIcon />,
		label: t("toolbar.image"),
		group: 2,
		disabled: !filePath || imageBusy,
		onClick: () => {
			void insertImage();
		},
		onMouseDown: keepSourceFocus,
	});

	return (
		<ResponsiveFixedToolbar
			variant="header"
			actions={actions}
			trailing={<MarkdownPaperNotesButton />}
		/>
	);
}
