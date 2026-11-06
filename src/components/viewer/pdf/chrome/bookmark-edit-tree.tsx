import {
	ArrowDown,
	ArrowUp,
	CornerDownRight,
	CornerUpLeft,
	MapPin,
	MoreHorizontal,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMacOS } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { bookmarkPageIndex } from "@/lib/pdf/bookmark";
import {
	type EditableBookmark,
	moveBookmark,
	updateBookmark,
} from "@/lib/pdf/bookmark-edit";

export function BookmarkEditTree({
	nodes,
	onChange,
	onAddChild,
	onRetarget,
	onGoToPage,
	disabled,
}: {
	nodes: EditableBookmark[];
	onChange: (nodes: EditableBookmark[]) => void;
	onAddChild: (node: EditableBookmark) => void;
	onRetarget: (node: EditableBookmark) => void;
	onGoToPage: (page: number) => void;
	disabled: boolean;
}) {
	const { t } = useTranslation("viewer");
	const [rename, setRename] = useState<{ id: string; title: string } | null>(
		null,
	);
	const renaming = useRef(false);
	const focusRename = useCallback(
		(input: HTMLInputElement | null) => input?.focus(),
		[],
	);
	const startRename = (node: EditableBookmark) => {
		renaming.current = true;
		setRename({ id: node.id, title: node.title });
	};
	const finishRename = (node: EditableBookmark, cancel = false) => {
		if (!renaming.current) return;
		renaming.current = false;
		const title = rename?.title.trim();
		setRename(null);
		if (!cancel && title && title !== node.title)
			onChange(updateBookmark(nodes, node.id, (item) => ({ ...item, title })));
	};
	const [dragId, setDragId] = useState<string | null>(null);
	const [drop, setDrop] = useState<{
		id: string;
		position: "before" | "after" | "inside";
	} | null>(null);
	const render = (
		items: EditableBookmark[],
		depth: number,
		parent?: EditableBookmark,
	) => (
		<ul className="space-y-0.5">
			{items.map((node, index) => {
				const page = node.pageIndex ?? bookmarkPageIndex(node);
				return (
					<li key={node.id}>
						<fieldset
							aria-label={node.title}
							draggable={!disabled && !rename}
							onDragStart={(event) => {
								event.stopPropagation();
								event.dataTransfer.setData("text/plain", node.id);
								event.dataTransfer.effectAllowed = "move";
								setDragId(node.id);
							}}
							onDragEnd={() => {
								setDragId(null);
								setDrop(null);
							}}
							onDragOver={(event) => {
								if (!dragId || disabled) return;
								event.preventDefault();
								event.stopPropagation();
								const bounds = event.currentTarget.getBoundingClientRect();
								const fraction = (event.clientY - bounds.top) / bounds.height;
								setDrop({
									id: node.id,
									position:
										fraction < 0.25
											? "before"
											: fraction > 0.75
												? "after"
												: "inside",
								});
							}}
							onDrop={(event) => {
								event.preventDefault();
								event.stopPropagation();
								if (dragId && drop && !disabled)
									onChange(moveBookmark(nodes, dragId, node.id, drop.position));
								setDrop(null);
								setDragId(null);
							}}
							className={cn(
								"group flex min-h-8 min-w-0 w-full items-center rounded-md border-y border-transparent transition-colors hover:bg-muted/60",
								dragId === node.id && "opacity-40",
								drop?.id === node.id &&
									(drop.position === "inside"
										? "bg-accent ring-1 ring-primary/40"
										: drop.position === "before"
											? "border-t-primary"
											: "border-b-primary"),
							)}
							style={{ paddingLeft: `${0.25 + Math.min(depth, 10) * 0.75}rem` }}
						>
							{rename?.id === node.id ? (
								<input
									ref={focusRename}
									aria-label={t("pdf.bookmarks.rename")}
									value={rename.title}
									className="min-w-0 flex-1 rounded border border-ring bg-transparent px-1 py-1 text-sm outline-none"
									onFocus={(event) => event.target.select()}
									onChange={(event) =>
										setRename({ id: node.id, title: event.target.value })
									}
									onBlur={() => finishRename(node)}
									onKeyDown={(event) => {
										if (event.nativeEvent.isComposing || event.keyCode === 229)
											return;
										if (event.key === "Enter" || event.key === "Escape") {
											event.preventDefault();
											event.stopPropagation();
											finishRename(node, event.key === "Escape");
										}
									}}
								/>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring"
											aria-keyshortcuts={isMacOS() ? "Enter F2" : "F2"}
											onKeyDown={(event) => {
												if (
													(event.key === "F2" ||
														(isMacOS() && event.key === "Enter")) &&
													!disabled
												) {
													event.preventDefault();
													startRename(node);
												}
											}}
											onClick={(event) => {
												event.currentTarget.focus({ preventScroll: true });
												if (page !== null) onGoToPage(page + 1);
											}}
										>
											{node.title}
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="right"
										sideOffset={8}
										className="max-w-80 whitespace-normal break-words"
									>
										<span className="min-w-0 [overflow-wrap:anywhere]">
											{node.title}
										</span>
									</TooltipContent>
								</Tooltip>
							)}
							<div className="grid min-w-6 shrink-0 items-center [&:has([data-state=open])>span]:opacity-0">
								{page !== null && (
									<span className="pointer-events-none col-start-1 row-start-1 px-1 text-center text-muted-foreground text-xs tabular-nums group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0">
										{page + 1}
									</span>
								)}
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											className="col-start-1 row-start-1 w-full opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
											size="icon-xs"
											disabled={disabled || Boolean(rename)}
											aria-label={t("pdf.bookmarks.actions", {
												title: node.title,
											})}
										>
											<MoreHorizontal className="size-3.5" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="start"
										className="min-w-40 whitespace-nowrap"
										onCloseAutoFocus={(event) => {
											if (renaming.current) event.preventDefault();
										}}
									>
										<DropdownMenuItem onSelect={() => startRename(node)}>
											<Pencil />
											{t("pdf.bookmarks.rename")}
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => onRetarget(node)}>
											<MapPin />
											{t("pdf.bookmarks.useCurrentPage")}
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => onAddChild(node)}>
											<Plus />
											{t("pdf.bookmarks.addChild")}
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											disabled={index === 0}
											onSelect={() =>
												onChange(
													moveBookmark(
														nodes,
														node.id,
														items[index - 1].id,
														"before",
													),
												)
											}
										>
											<ArrowUp />
											{t("pdf.bookmarks.up")}
										</DropdownMenuItem>
										<DropdownMenuItem
											disabled={index === items.length - 1}
											onSelect={() =>
												onChange(
													moveBookmark(
														nodes,
														node.id,
														items[index + 1].id,
														"after",
													),
												)
											}
										>
											<ArrowDown />
											{t("pdf.bookmarks.down")}
										</DropdownMenuItem>
										<DropdownMenuItem
											disabled={index === 0}
											onSelect={() =>
												onChange(
													moveBookmark(
														nodes,
														node.id,
														items[index - 1].id,
														"inside",
													),
												)
											}
										>
											<CornerDownRight />
											{t("pdf.bookmarks.indent")}
										</DropdownMenuItem>
										<DropdownMenuItem
											disabled={!parent}
											onSelect={() => {
												if (parent)
													onChange(
														moveBookmark(nodes, node.id, parent.id, "after"),
													);
											}}
										>
											<CornerUpLeft />
											{t("pdf.bookmarks.outdent")}
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											variant="destructive"
											onSelect={() =>
												onChange(updateBookmark(nodes, node.id, () => null))
											}
										>
											<Trash2 />
											{t("pdf.bookmarks.delete")}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</fieldset>
						{node.children.length > 0 && render(node.children, depth + 1, node)}
					</li>
				);
			})}
		</ul>
	);
	return (
		<TooltipProvider delayDuration={300}>{render(nodes, 0)}</TooltipProvider>
	);
}
