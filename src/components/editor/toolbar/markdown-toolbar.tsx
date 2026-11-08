"use client";

import { ListStyleType } from "@platejs/list";
import {
	useIndentTodoToolBarButton,
	useIndentTodoToolBarButtonState,
	useListToolbarButton,
	useListToolbarButtonState,
} from "@platejs/list/react";
import { insertImage } from "@platejs/media";
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
	ListTree,
	Loader2,
	type LucideIcon,
	Quote,
	Search,
	Share,
	Strikethrough,
	Underline,
} from "lucide-react";
import { KEYS } from "platejs";
import {
	useEditorRef,
	useEditorSelector,
	useMarkToolbarButton,
	useSelectionFragmentProp,
} from "platejs/react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { CoolPapersIcon } from "@/components/icons/cool-papers-icon";

import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useLibraryStore } from "@/hooks/use-app-stores";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { copyFileToMarkdownAssets, pickImageFiles } from "@/lib/markdown/image";
import { hasTextSelection } from "@/lib/markdown/input-context";
import { fetchCoolPapersNotes } from "@/lib/paper/coolpapers";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import { paperRelFromNotes } from "@/lib/vault";
import { useWikiNav } from "@/lib/wiki/nav-context";
import { ToolbarButton } from "./primitives";
import {
	ResponsiveFixedToolbar,
	type ToolbarAction,
} from "./responsive-toolbar";

function useBlockTypeAction(
	blockType: string | undefined,
	type: string,
	icon: LucideIcon,
	label: string,
): ToolbarAction {
	const editor = useEditorRef();
	const Icon = icon;
	return {
		id: type,
		icon: <Icon />,
		label,
		pressed: blockType === type,
		onClick: () => editor.tf.toggleBlock(type),
		group: 0,
	};
}

function useMarkAction(
	nodeType: string,
	icon: LucideIcon,
	label: string,
): ToolbarAction {
	const pressed = useEditorSelector(
		(editor) =>
			hasTextSelection(editor) ? editor.api.hasMark(nodeType) : undefined,
		[nodeType],
	);
	const { props } = useMarkToolbarButton({
		nodeType,
		pressed: pressed ?? false,
		clear: undefined,
	});
	const Icon = icon;
	return {
		id: nodeType,
		icon: <Icon />,
		label,
		pressed: props.pressed,
		disabled: pressed === undefined,
		onClick: props.onClick,
		group: 1,
	};
}

function useListAction(
	nodeType: string,
	icon: LucideIcon,
	label: string,
): ToolbarAction {
	const state = useListToolbarButtonState({ nodeType });
	const { props } = useListToolbarButton(state);
	const Icon = icon;
	return {
		id: nodeType,
		icon: <Icon />,
		label,
		pressed: props.pressed,
		onClick: props.onClick,
		group: 2,
	};
}

function useTodoListAction(icon: LucideIcon, label: string): ToolbarAction {
	const state = useIndentTodoToolBarButtonState({ nodeType: KEYS.listTodo });
	const { props } = useIndentTodoToolBarButton(state);
	const Icon = icon;
	return {
		id: KEYS.listTodo,
		icon: <Icon />,
		label,
		pressed: props.pressed,
		onClick: props.onClick,
		group: 2,
	};
}

function useImageAction(label: string): ToolbarAction {
	const { t } = useTranslation("editor");
	const editor = useEditorRef();
	const { filePath, onAssetsChanged } = useMarkdownDoc();
	const [busy, setBusy] = useState(false);

	const onClick = useCallback(async () => {
		if (!filePath || busy) {
			if (!filePath) notifyError(t("image.noFile"));
			return;
		}
		setBusy(true);
		try {
			const paths = await pickImageFiles();
			if (!paths.length) return;
			for (const src of paths) {
				const rel = await copyFileToMarkdownAssets(filePath, src);
				insertImage(editor, rel);
			}
			onAssetsChanged?.();
		} catch (e) {
			notifyError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	}, [busy, editor, filePath, onAssetsChanged, t]);

	return {
		id: "image",
		icon: <ImageIcon />,
		label,
		disabled: !filePath || busy,
		onClick,
		group: 2,
	};
}

/** Cool Papers Kimi notes — only on a paper NOTES.md that is in the catalog. */
function FetchKimiNotesButton() {
	const { t } = useTranslation("editor");
	const { filePath } = useMarkdownDoc();
	const vaultPath = useWikiNav()?.vaultPath ?? null;
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const [busy, setBusy] = useState(false);

	const meta = useMemo(() => {
		if (!filePath || !vaultPath) return null;
		if (!/NOTES\.md$/i.test(filePath.replace(/\\/g, "/"))) return null;
		const rel = paperRelFromNotes(filePath, vaultPath);
		return (rel && paperMetaByRelPath.get(rel)) || null;
	}, [filePath, vaultPath, paperMetaByRelPath]);

	const onClick = useCallback(() => {
		if (!meta || busy) return;
		setBusy(true);
		void fetchCoolPapersNotes(meta).finally(() => setBusy(false));
	}, [busy, meta]);

	if (!meta) return null;

	return (
		<ToolbarButton
			tooltip={t("toolbar.fetchKimiNotes")}
			aria-label={t("toolbar.fetchKimiNotes")}
			data-fetch-cool-papers-notes
			disabled={busy}
			onClick={onClick}
			className="gap-1 px-2"
		>
			{busy ? <Loader2 className="animate-spin" /> : <CoolPapersIcon />}
			<span className="text-xs font-medium">
				{t("toolbar.fetchKimiNotesShort")}
			</span>
		</ToolbarButton>
	);
}

/**
 * WYSIWYG formatting toolbar for the Markdown/notes editor. Must be rendered
 * inside a `<Plate>` provider (it reads editor state via Plate hooks).
 */
export function MarkdownEditorToolbar({
	onOpenFind,
	onExport,
	propertiesPanel,
}: {
	/** Show the Search button at the right end; opens the find & replace bar. */
	onOpenFind?: () => void;
	/** Export the current note as PDF / PNG. */
	onExport?: () => void;
	/** Content rendered in the Properties toolbar popover. */
	propertiesPanel?: ReactNode;
}) {
	const { t } = useTranslation("editor");
	const blockType = useSelectionFragmentProp({
		defaultValue: KEYS.p,
		getProp: (node) => node.type,
	});

	const h1 = useBlockTypeAction(blockType, KEYS.h1, Heading1, t("toolbar.h1"));
	const h2 = useBlockTypeAction(blockType, KEYS.h2, Heading2, t("toolbar.h2"));
	const h3 = useBlockTypeAction(blockType, KEYS.h3, Heading3, t("toolbar.h3"));
	const quote = useBlockTypeAction(
		blockType,
		KEYS.blockquote,
		Quote,
		t("toolbar.quote"),
	);

	const bold = useMarkAction(KEYS.bold, Bold, t("toolbar.bold"));
	const italic = useMarkAction(KEYS.italic, Italic, t("toolbar.italic"));
	const underline = useMarkAction(
		KEYS.underline,
		Underline,
		t("toolbar.underline"),
	);
	const strikethrough = useMarkAction(
		KEYS.strikethrough,
		Strikethrough,
		t("toolbar.strikethrough"),
	);
	const code = useMarkAction(KEYS.code, Code, t("toolbar.code"));
	const highlight = useMarkAction(
		KEYS.highlight,
		Highlighter,
		t("toolbar.highlight"),
	);

	const bulletedList = useListAction(
		ListStyleType.Disc,
		List,
		t("toolbar.bulletedList"),
	);
	const numberedList = useListAction(
		ListStyleType.Decimal,
		ListOrdered,
		t("toolbar.numberedList"),
	);
	const todoList = useTodoListAction(ListTodo, t("toolbar.todoList"));
	const image = useImageAction(t("toolbar.image"));

	const actions = useMemo<ToolbarAction[]>(
		() => [
			h1,
			h2,
			h3,
			quote,
			bold,
			italic,
			underline,
			strikethrough,
			code,
			highlight,
			bulletedList,
			numberedList,
			todoList,
			image,
		],
		[
			h1,
			h2,
			h3,
			quote,
			bold,
			italic,
			underline,
			strikethrough,
			code,
			highlight,
			bulletedList,
			numberedList,
			todoList,
			image,
		],
	);

	return (
		<ResponsiveFixedToolbar
			actions={actions}
			className="rounded-none"
			trailing={
				<>
					{propertiesPanel ? (
						<Popover>
							<PopoverTrigger asChild>
								<ToolbarButton
									tooltip={t("toolbar.properties")}
									aria-label={t("toolbar.properties")}
								>
									<ListTree />
								</ToolbarButton>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								className="w-[min(30rem,calc(100vw-1rem))] p-2.5"
							>
								{propertiesPanel}
							</PopoverContent>
						</Popover>
					) : null}
					<FetchKimiNotesButton />
					{onExport ? (
						<ToolbarButton
							tooltip={t("export.toolbar")}
							aria-label={t("export.toolbar")}
							onClick={onExport}
						>
							<Share />
						</ToolbarButton>
					) : null}
					{onOpenFind ? (
						<ToolbarButton
							tooltip={`${t("findReplace.title")} (${formatModShortcut("f")})`}
							aria-label={t("findReplace.title")}
							onClick={onOpenFind}
						>
							<Search />
						</ToolbarButton>
					) : null}
				</>
			}
		/>
	);
}
