import { ZodError } from "zod";
import i18n from "@/i18n";

const messages = {
	"duplicate identity or field name": "duplicate",
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
	return i18n.t("editor:researchTable.invalid", { detail });
}
