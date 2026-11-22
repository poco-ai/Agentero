import { ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { isPublicationDateInput, publicationDateText } from "@/lib/paper";
import {
	type PaperMetaPatch,
	resolveIdentifierMetadata,
} from "@/lib/paper/api";
import type { PaperMetadata } from "@/lib/paper/types";

type Draft = {
	title: string;
	authors: string;
	date: string;
	doi: string;
	arxivId: string;
	publication: string;
	volume: string;
	issue: string;
	pages: string;
	publisher: string;
	abstract: string;
	pdfUrl: string;
	htmlUrl: string;
	codeRepo: string;
	openreviewUrl: string;
};

function draftFromPaper(paper: PaperMetadata): Draft {
	return {
		title: paper.title ?? "",
		authors: (paper.authors ?? []).join("\n"),
		date: publicationDateText(paper),
		doi: paper.doi ?? "",
		arxivId: paper.arxiv_id ?? "",
		publication: paper.publication ?? "",
		volume: paper.volume ?? "",
		issue: paper.issue ?? "",
		pages: paper.pages ?? "",
		publisher: paper.publisher ?? "",
		abstract: paper.abstract ?? "",
		pdfUrl: paper.pdf_url ?? "",
		htmlUrl: paper.html_url ?? "",
		codeRepo: paper.code_repo ?? "",
		openreviewUrl: paper.openreview_url ?? "",
	};
}

/** Only changed fields go into the patch (backend keeps omitted columns). */
function diffDraft(initial: Draft, current: Draft): PaperMetaPatch {
	const patch: PaperMetaPatch = {};
	if (current.title !== initial.title) patch.title = current.title;
	if (current.authors !== initial.authors) {
		patch.authors = current.authors
			.split("\n")
			.map((a) => a.trim())
			.filter(Boolean);
	}
	if (current.date !== initial.date) patch.date = current.date;
	if (current.doi !== initial.doi) patch.doi = current.doi;
	if (current.arxivId !== initial.arxivId) patch.arxivId = current.arxivId;
	if (current.publication !== initial.publication)
		patch.publication = current.publication;
	if (current.volume !== initial.volume) patch.volume = current.volume;
	if (current.issue !== initial.issue) patch.issue = current.issue;
	if (current.pages !== initial.pages) patch.pages = current.pages;
	if (current.publisher !== initial.publisher)
		patch.publisher = current.publisher;
	if (current.abstract !== initial.abstract) patch.abstract = current.abstract;
	if (current.pdfUrl !== initial.pdfUrl) patch.pdfUrl = current.pdfUrl;
	if (current.htmlUrl !== initial.htmlUrl) patch.htmlUrl = current.htmlUrl;
	if (current.codeRepo !== initial.codeRepo) patch.codeRepo = current.codeRepo;
	if (current.openreviewUrl !== initial.openreviewUrl)
		patch.openreviewUrl = current.openreviewUrl;
	return patch;
}

/**
 * Manual metadata editor shared by the Paper Info panel and the Library
 * table row context menu. Submits a patch (changed fields only).
 */
export function EditPaperMetaDialog({
	paper,
	onOpenChange,
	onConfirm,
}: {
	paper: PaperMetadata | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (paper: PaperMetadata, patch: PaperMetaPatch) => Promise<void>;
}) {
	const { t } = useTranslation("sidebar");
	const open = paper !== null;
	const unresolved = paper?.meta_source === "local-unresolved";
	const [initial, setInitial] = useState<Draft | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [refreshError, setRefreshError] = useState(false);

	useOverlayRegistration("edit-paper-meta", open, () => onOpenChange(false));

	useEffect(() => {
		if (!paper) return;
		const next = draftFromPaper(paper);
		setInitial(next);
		setDraft(next);
		setMoreOpen(false);
		setSaving(false);
		setRefreshing(false);
		setRefreshError(false);
	}, [paper]);

	const patch = useMemo(
		() => (initial && draft ? diffDraft(initial, draft) : {}),
		[initial, draft],
	);
	const dirty = Object.keys(patch).length > 0;
	const canSubmit =
		!saving &&
		dirty &&
		(draft?.title.trim().length ?? 0) > 0 &&
		isPublicationDateInput(draft?.date ?? "");

	const set = (key: keyof Draft, value: string) => {
		setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
	};

	const handleConfirm = async () => {
		if (!paper || !canSubmit) return;
		setSaving(true);
		try {
			await onConfirm(paper, patch);
		} finally {
			setSaving(false);
		}
	};

	/** Fill the form from DOI/arXiv identifier metadata, or by title search. */
	const handleRefreshFromIdentifier = async () => {
		if (!draft) return;
		const text = draft.doi.trim() || draft.arxivId.trim() || draft.title.trim();
		if (!text) return;
		setRefreshing(true);
		setRefreshError(false);
		try {
			const meta = await resolveIdentifierMetadata(text);
			setDraft((prev) =>
				prev
					? {
							...prev,
							title: meta.title?.trim() || prev.title,
							authors: meta.authors?.length
								? meta.authors.join("\n")
								: prev.authors,
							date: publicationDateText(meta) || prev.date,
							doi: meta.doi?.trim() || prev.doi,
							arxivId: meta.arxiv_id?.trim() || prev.arxivId,
							publication: meta.publication?.trim() || prev.publication,
							volume: meta.volume?.trim() || prev.volume,
							issue: meta.issue?.trim() || prev.issue,
							pages: meta.pages?.trim() || prev.pages,
							publisher: meta.publisher?.trim() || prev.publisher,
							abstract: meta.abstract?.trim() || prev.abstract,
							pdfUrl: meta.pdf_url?.trim() || prev.pdfUrl,
							htmlUrl: meta.html_url?.trim() || prev.htmlUrl,
						}
					: prev,
			);
		} catch {
			setRefreshError(true);
		} finally {
			setRefreshing(false);
		}
	};

	if (!draft) {
		return null;
	}

	const field = (
		key: keyof Draft,
		label: string,
		props?: React.ComponentProps<typeof Input>,
	) => (
		<div className="space-y-1">
			<Label htmlFor={`edit-meta-${key}`} className="text-xs">
				{label}
			</Label>
			<Input
				id={`edit-meta-${key}`}
				value={draft[key]}
				onChange={(e) => set(key, e.target.value)}
				disabled={saving}
				spellCheck={false}
				{...props}
			/>
		</div>
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex! max-h-[75vh] min-h-0 flex-col gap-3 overflow-hidden sm:max-w-lg"
				aria-describedby={unresolved ? "edit-meta-unresolved" : undefined}
			>
				<DialogHeader className="shrink-0">
					<DialogTitle>{t("paperInfo.editMeta.title")}</DialogTitle>
					{unresolved && (
						<DialogDescription id="edit-meta-unresolved">
							{t("paperInfo.editMeta.unresolved")}
						</DialogDescription>
					)}
				</DialogHeader>

				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
					{field("title", t("paperInfo.editMeta.fieldTitle"))}
					<div className="space-y-1">
						<Label htmlFor="edit-meta-authors" className="text-xs">
							{t("paperInfo.editMeta.fieldAuthors")}
						</Label>
						<Textarea
							id="edit-meta-authors"
							className="max-h-32 overflow-y-auto"
							value={draft.authors}
							onChange={(e) => set("authors", e.target.value)}
							placeholder={t("paperInfo.editMeta.authorsPlaceholder")}
							disabled={saving}
							spellCheck={false}
							rows={3}
						/>
					</div>
					<div className="grid grid-cols-2 gap-2">
						{field("date", t("paperInfo.editMeta.fieldDate"), {
							placeholder: "2024-06-12",
							"aria-invalid": !isPublicationDateInput(draft.date) || undefined,
						})}
						{field("arxivId", t("paperInfo.editMeta.fieldArxivId"), {
							className: "font-mono text-xs",
						})}
					</div>
					<div className="grid grid-cols-[1fr_auto] items-end gap-2">
						{field("doi", t("paperInfo.editMeta.fieldDoi"), {
							className: "font-mono text-xs",
							placeholder: "10.1000/xyz123",
						})}
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-9 gap-1"
							title={t("paperInfo.editMeta.refreshTitle")}
							disabled={
								saving ||
								refreshing ||
								!(
									draft.doi.trim() ||
									draft.arxivId.trim() ||
									draft.title.trim()
								)
							}
							onClick={() => void handleRefreshFromIdentifier()}
						>
							<RefreshCw
								className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
								aria-hidden
							/>
							{refreshing
								? t("paperInfo.editMeta.refreshing")
								: t("paperInfo.editMeta.refresh")}
						</Button>
					</div>
					{refreshError && (
						<p className="text-destructive text-xs">
							{t("paperInfo.editMeta.fetchFailed")}
						</p>
					)}
					{field("publication", t("paperInfo.editMeta.fieldPublication"))}

					<Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
						<CollapsibleTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="w-full justify-start gap-1 px-1 text-muted-foreground text-xs"
							>
								<ChevronDown
									className={`size-3.5 transition-transform ${moreOpen ? "" : "-rotate-90"}`}
								/>
								{t("paperInfo.editMeta.moreFields")}
							</Button>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-3 pt-2">
							<div className="grid grid-cols-3 gap-2">
								{field("volume", t("paperInfo.editMeta.fieldVolume"))}
								{field("issue", t("paperInfo.editMeta.fieldIssue"))}
								{field("pages", t("paperInfo.editMeta.fieldPages"))}
							</div>
							{field("publisher", t("paperInfo.editMeta.fieldPublisher"))}
							<div className="space-y-1">
								<Label htmlFor="edit-meta-abstract" className="text-xs">
									{t("paperInfo.editMeta.fieldAbstract")}
								</Label>
								<Textarea
									id="edit-meta-abstract"
									value={draft.abstract}
									onChange={(e) => set("abstract", e.target.value)}
									disabled={saving}
									rows={4}
								/>
							</div>
							{field("pdfUrl", t("paperInfo.editMeta.fieldPdfUrl"), {
								className: "font-mono text-xs",
								inputMode: "url",
							})}
							{field("htmlUrl", t("paperInfo.editMeta.fieldHtmlUrl"), {
								className: "font-mono text-xs",
								inputMode: "url",
							})}
							{field("codeRepo", t("paperInfo.editMeta.fieldCodeRepo"), {
								className: "font-mono text-xs",
								inputMode: "url",
								placeholder: "https://github.com/owner/repo",
							})}
							{field(
								"openreviewUrl",
								t("paperInfo.editMeta.fieldOpenreviewUrl"),
								{
									className: "font-mono text-xs",
									inputMode: "url",
									placeholder: "https://openreview.net/forum?id=…",
								},
							)}
						</CollapsibleContent>
					</Collapsible>
				</div>

				<DialogFooter className="shrink-0 gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						{t("paperInfo.editMeta.cancel")}
					</Button>
					<Button type="button" onClick={handleConfirm} disabled={!canSubmit}>
						{t("paperInfo.editMeta.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
