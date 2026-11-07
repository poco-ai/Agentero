import { ZodError } from "zod";
import i18n from "@/i18n";

const messages = {
	"duplicate identity or field name": "duplicate",
	"duplicate registry id": "duplicate",
	"invalid registry id": "registry",
	"invalid table path": "path",
	"invalid link field": "link",
	"archive before delete": "archiveFirst",
	"invalid select options": "options",
	"row limit": "rows",
	"paste limit": "paste",
	"column limit": "columns",
	"cell bounds": "bounds",
	"existing values require an explicit type or unit migration": "migration",
	"a table requires at least one field": "lastField",
} as const;

export function researchTableErrorMessage(error: unknown): string {
	if (error instanceof ZodError)
		return i18n.t("editor:researchTable.errors.schema");
	const detail = error instanceof Error ? error.message : String(error);
	if (detail.startsWith("invalid cell:"))
		return i18n.t("editor:researchTable.errors.values");
	const code = messages[detail as keyof typeof messages];
	if (code) return i18n.t(`editor:researchTable.errors.${code}`);
	const optionUse = /^option in use: (\d+)$/.exec(detail);
	if (optionUse)
		return i18n.t("editor:researchTable.errors.optionInUse", {
			count: Number(optionUse[1]),
		});
	return i18n.t("editor:researchTable.invalid", { detail });
}
