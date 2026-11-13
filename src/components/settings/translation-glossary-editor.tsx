import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { notifyError } from "@/lib/core/notify";
import { MAX_GLOSSARY_CHARS, parseGlossary } from "@/lib/translate/glossary";

export function TranslationGlossaryEditor({
	value,
	language,
	onSave,
}: {
	value: string;
	language: string;
	onSave: (value: string) => void;
}) {
	const { t } = useTranslation("settings");
	const [draft, setDraft] = useState(value);
	const [invalid, setInvalid] = useState(false);
	useEffect(() => {
		setDraft(value);
		setInvalid(false);
	}, [value]);
	const dirty = draft.trim() !== value.trim();
	let count = 0;
	try {
		count = parseGlossary(draft).length;
	} catch {
		/* Validate on save, preserve drafts while typing. */
	}
	const save = () => {
		try {
			const terms = parseGlossary(draft);
			const canonical = terms.length
				? JSON.stringify(Object.fromEntries(terms), null, 2)
				: "";
			setInvalid(false);
			onSave(canonical);
			setDraft(canonical);
		} catch {
			setInvalid(true);
			notifyError(t("translate.glossary.invalid"));
		}
	};
	return (
		<section className="mb-5" aria-labelledby="translation-glossary-label">
			<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
				<label
					id="translation-glossary-label"
					htmlFor="translation-glossary"
					className="font-medium text-sm"
				>
					{t("translate.glossary.label", { language })}
				</label>
				<span className="text-caption text-muted-foreground">
					{t("translate.glossary.count", { count })}
				</span>
			</div>
			<Textarea
				id="translation-glossary"
				value={draft}
				maxLength={MAX_GLOSSARY_CHARS}
				rows={5}
				spellCheck={false}
				aria-invalid={invalid}
				aria-describedby="translation-glossary-hint"
				placeholder={t("translate.glossary.placeholder")}
				className="min-h-28 resize-y font-mono text-sm"
				onChange={(event) => {
					setDraft(event.target.value);
					setInvalid(false);
				}}
				onKeyDown={(event) => {
					if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
						event.preventDefault();
						save();
					}
				}}
			/>
			<div className="mt-2 flex items-start justify-between gap-3">
				<p
					id="translation-glossary-hint"
					className="max-w-lg text-caption text-muted-foreground"
				>
					{t("translate.glossary.hint")}
				</p>
				<div className="flex shrink-0 gap-1.5">
					{dirty && (
						<Button
							size="xs"
							variant="ghost"
							onClick={() => {
								setDraft(value);
								setInvalid(false);
							}}
						>
							{t("translate.glossary.cancel")}
						</Button>
					)}
					<Button size="xs" variant="outline" disabled={!dirty} onClick={save}>
						{t("translate.glossary.save")}
					</Button>
				</div>
			</div>
		</section>
	);
}
