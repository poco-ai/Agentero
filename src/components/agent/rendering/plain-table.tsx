"use client";

import { Copy, Download, Maximize2 } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	extractTableDataFromElement,
	tableDataToCSV,
	tableDataToMarkdown,
	tableDataToTSV,
} from "streamdown";
import { downloadText } from "@/components/agent/rendering/plain-code-block";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";

type PlainTableProps = ComponentPropsWithoutRef<"table"> & {
	node?: unknown;
};

export function PlainTable({
	children,
	className,
	node: _node,
	...props
}: PlainTableProps) {
	const { t } = useTranslation("aiElements");
	const tableRef = useRef<HTMLTableElement>(null);

	const getData = useCallback(() => {
		const table = tableRef.current;
		if (!table) return null;
		try {
			return extractTableDataFromElement(table);
		} catch {
			return null;
		}
	}, []);

	const handleCopy = useCallback(
		(format: "csv" | "tsv" | "md") => {
			const data = getData();
			if (!data) return;
			const text =
				format === "csv"
					? tableDataToCSV(data)
					: format === "tsv"
						? tableDataToTSV(data)
						: tableDataToMarkdown(data);
			void copyTextToClipboard(text, {
				successMessage: t("table.copy"),
			});
		},
		[getData, t],
	);

	const handleDownload = useCallback(
		(format: "csv" | "markdown") => {
			const data = getData();
			if (!data) return;
			const text =
				format === "csv" ? tableDataToCSV(data) : tableDataToMarkdown(data);
			downloadText(`table.${format === "csv" ? "csv" : "md"}`, text);
		},
		[getData],
	);

	const handleFullscreen = useCallback(() => {
		tableRef.current?.requestFullscreen().catch(() => undefined);
	}, []);

	const iconButtonClass =
		"size-7 opacity-70 hover:opacity-100 focus-visible:opacity-100";

	return (
		<div className="group/table relative my-4 overflow-x-auto">
			<table
				ref={tableRef}
				className={cn("w-full caption-bottom text-sm", className)}
				{...props}
			>
				{children}
			</table>

			<div
				className={cn(
					"absolute right-2 top-2 flex items-center gap-1 rounded-md border bg-background/95 p-1 shadow-raised",
					"opacity-0 transition-opacity group-hover/table:opacity-100",
					"focus-within:opacity-100",
				)}
			>
				<TooltipProvider>
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className={iconButtonClass}
										aria-label={t("table.copy")}
									>
										<Copy className="size-4" />
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent>
								<p>{t("table.copy")}</p>
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => handleCopy("md")}>
								{t("table.copyAsMarkdown")}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => handleCopy("csv")}>
								{t("table.copyAsCsv")}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => handleCopy("tsv")}>
								{t("table.copyAsTsv")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>

					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className={iconButtonClass}
										aria-label={t("table.download")}
									>
										<Download className="size-4" />
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent>
								<p>{t("table.download")}</p>
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => handleDownload("csv")}>
								{t("table.downloadAsCsv")}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => handleDownload("markdown")}>
								{t("table.downloadAsMarkdown")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={iconButtonClass}
								aria-label={t("table.viewFullscreen")}
								onClick={handleFullscreen}
							>
								<Maximize2 className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>{t("table.viewFullscreen")}</p>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
		</div>
	);
}
