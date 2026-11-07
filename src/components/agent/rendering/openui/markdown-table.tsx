"use client";

import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { PlainTable } from "@/components/agent/rendering/plain-table";
import { openUiTableToGfm } from "@/lib/agent/openui/format";

const TABLE_COMPONENTS = { table: PlainTable };

/**
 * OpenUI Table reuses the chat Markdown table renderer: the structured data is
 * serialized to GFM and handed to Streamdown, so copy / download / styling stay
 * identical to a regular assistant table.
 */
export function OpenUiTable({
	columns,
	rows,
	caption,
}: {
	columns: string[];
	rows: string[][];
	caption?: string;
}) {
	const { t } = useTranslation("agent");
	const markdown = openUiTableToGfm(columns, rows);

	return (
		<figure className="my-1 min-w-0" data-openui-table>
			{caption ? (
				<figcaption className="mb-1 text-xs text-muted-foreground">
					{caption}
				</figcaption>
			) : null}
			{rows.length === 0 ? (
				<p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
					{t("uiBlock.tableEmpty")}
				</p>
			) : (
				<Streamdown
					mode="static"
					className="w-full min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
					components={TABLE_COMPONENTS}
					linkSafety={{ enabled: false }}
				>
					{markdown}
				</Streamdown>
			)}
		</figure>
	);
}
