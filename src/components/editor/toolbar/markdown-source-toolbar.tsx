import { openSearchPanel } from "@codemirror/search";
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
	Quote,
	Search,
	Share,
	Strikethrough,
	Underline,
} from "lucide-react";
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { copyFileToMarkdownAssets, pickImageFiles } from "@/lib/markdown/image";
import type { MarkdownSourceFormat } from "@/lib/markdown/source-format";
import { sourceFormatTransaction } from "@/lib/markdown/source-format";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import { ToolbarButton } from "./primitives";
import {
	ResponsiveFixedToolbar,
	type ToolbarAction,
} from "./responsive-toolbar";

type FormatAction = {
	format: MarkdownSourceFormat;
	icon: LucideIcon;
	label: string;
	group: number;
};

/**
 * Source-mode formatting toolbar. Actions edit the CodeMirror document through
 * the same Markdown commands as the source keymap, so toolbar clicks and
 * shortcuts stay in sync.
 */
export function MarkdownSourceToolbar({
	viewRef,
	onExport,
	sourceToggle,
}: {
	viewRef: RefObject<EditorView | null>;
	/** Export the current source document as PDF / PNG / Markdown. */
	onExport?: () => void;
	sourceToggle?: ReactNode;
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

	const openFind = useCallback(() => {
		const view = viewRef.current;
		if (view) openSearchPanel(view);
	}, [viewRef]);

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

	const formatActions = useMemo<FormatAction[]>(
		() => [
			{ format: "heading1", icon: Heading1, label: t("toolbar.h1"), group: 0 },
			{ format: "heading2", icon: Heading2, label: t("toolbar.h2"), group: 0 },
			{ format: "heading3", icon: Heading3, label: t("toolbar.h3"), group: 0 },
			{ format: "quote", icon: Quote, label: t("toolbar.quote"), group: 0 },
			{ format: "bold", icon: Bold, label: t("toolbar.bold"), group: 1 },
			{ format: "italic", icon: Italic, label: t("toolbar.italic"), group: 1 },
			{
				format: "underline",
				icon: Underline,
				label: t("toolbar.underline"),
				group: 1,
			},
			{
				format: "strikethrough",
				icon: Strikethrough,
				label: t("toolbar.strikethrough"),
				group: 1,
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
		],
		[t],
	);

	const actions = useMemo<ToolbarAction[]>(() => {
		const shortcuts: Partial<Record<MarkdownSourceFormat, string>> = {
			bold: formatModShortcut("b"),
			italic: formatModShortcut("i"),
			underline: formatModShortcut("u"),
			strikethrough: formatModShortcut("x", { shift: true }),
		};
		const items: ToolbarAction[] = formatActions.map(
			({ format, icon, label, group }) => {
				const Icon = icon;
				const shortcut = shortcuts[format];
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
		items.push({
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
		return items;
	}, [
		filePath,
		formatActions,
		imageBusy,
		insertImage,
		keepSourceFocus,
		runFormat,
		t,
	]);

	return (
		<ResponsiveFixedToolbar
			actions={actions}
			className="rounded-none"
			trailing={
				<>
					{onExport ? (
						<ToolbarButton
							tooltip={t("export.toolbar")}
							aria-label={t("export.toolbar")}
							onMouseDown={keepSourceFocus}
							onClick={onExport}
						>
							<Share />
						</ToolbarButton>
					) : null}
					{sourceToggle}
					<ToolbarButton
						tooltip={`${t("findReplace.title")} (${formatModShortcut("f")})`}
						aria-label={t("findReplace.title")}
						onMouseDown={keepSourceFocus}
						onClick={openFind}
					>
						<Search />
					</ToolbarButton>
				</>
			}
		/>
	);
}
