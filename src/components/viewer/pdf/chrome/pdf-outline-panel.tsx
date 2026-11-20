import type { PdfBookmarkObject } from "@embedpdf/models";
import { Loader2, RotateCw } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { BookmarkEditTree } from "@/components/viewer/pdf/chrome/bookmark-edit-tree";
import { OutlineTree } from "@/components/viewer/pdf/chrome/outline-tree";
import { PDF_SIDE_PANEL } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import type { PdfBookmarkEditor } from "@/components/viewer/pdf/hooks/use-pdf-bookmark-editor";
import { cn } from "@/lib/core/utils";
import { type EditableBookmark, updateBookmark } from "@/lib/pdf/bookmark-edit";

type Form = {
	title: string;
	page: number;
	parent?: string;
};

/** Outline rail. Mounting is owned by the viewer's single left-panel slot. */
export function PdfOutlinePanel({
	outline,
	onGoToPage,
	editor,
	currentPage,
}: {
	outline: PdfBookmarkObject[];
	onGoToPage: (page: number) => void;
	editor: PdfBookmarkEditor;
	currentPage: number;
}) {
	const { t } = useTranslation("viewer");
	const titleId = useId();
	const [form, setForm] = useState<Form | null>(null);
	const { draft, canEdit, begin, change, save } = editor;
	const add = (parent?: string) => {
		begin();
		setForm({
			title: t("pdf.bookmarks.defaultTitle", { page: currentPage }),
			page: currentPage,
			parent,
		});
	};
	const valid = Boolean(form?.title.trim());
	const submit = () => {
		if (!form || !valid || draft?.saving) return;
		const nodes = editor.nodes;
		const node: EditableBookmark = {
			id: crypto.randomUUID(),
			origin: null,
			title: form.title.trim(),
			pageIndex: form.page - 1,
			children: [],
		};
		begin();
		change(
			form.parent
				? updateBookmark(nodes, form.parent, (parent) => ({
						...parent,
						children: [...parent.children, node],
					}))
				: [...nodes, node],
		);
		setForm(null);
	};
	return (
		<>
			<aside
				data-pdf-chrome
				className={cn("agentero-scroll", PDF_SIDE_PANEL)}
				aria-label={t("pdf.outline")}
			>
				{canEdit && (
					<div className="absolute top-2 right-2 z-10 flex items-center gap-0.5">
						{draft?.saving ? (
							<Loader2
								className="m-1.5 size-3.5 animate-spin motion-reduce:animate-none"
								aria-label={t("pdf.bookmarks.saving")}
							/>
						) : draft?.failed ? (
							<Button
								size="icon-xs"
								variant="ghost"
								title={t("pdf.bookmarks.retry")}
								aria-label={t("pdf.bookmarks.retry")}
								onClick={() => void save()}
							>
								<RotateCw className="size-3.5" />
							</Button>
						) : null}
					</div>
				)}
				<div className="px-2">
					{canEdit ? (
						<BookmarkEditTree
							nodes={editor.nodes}
							onChange={change}
							onAddChild={(node) => add(node.id)}
							onRetarget={(node) =>
								change(
									updateBookmark(editor.nodes, node.id, (item) => ({
										...item,
										pageIndex: currentPage - 1,
									})),
								)
							}
							onGoToPage={onGoToPage}
							disabled={Boolean(draft?.saving)}
						/>
					) : (
						<OutlineTree nodes={outline} depth={0} onGoToPage={onGoToPage} />
					)}
					{(draft?.nodes ?? outline).length === 0 && (
						<p className="px-2 py-3 text-muted-foreground text-xs">
							{t("pdf.bookmarks.empty")}
						</p>
					)}
				</div>
			</aside>
			<Dialog
				open={form !== null}
				onOpenChange={(open) => {
					if (!open) setForm(null);
				}}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("pdf.bookmarks.add")}</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							submit();
						}}
						className="space-y-4"
					>
						<label htmlFor={titleId} className="block space-y-1 text-sm">
							<span>{t("pdf.bookmarks.title")}</span>
							<Input
								id={titleId}
								autoFocus
								value={form?.title ?? ""}
								onFocus={(event) => event.target.select()}
								onChange={(event) =>
									setForm((old) => old && { ...old, title: event.target.value })
								}
							/>
						</label>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setForm(null)}
							>
								{t("pdf.bookmarks.cancel")}
							</Button>
							<Button type="submit" disabled={!valid || draft?.saving}>
								{t("pdf.bookmarks.apply")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
