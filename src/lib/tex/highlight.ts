/**
 * Source-mode LaTeX token roles. The grammar already names these nodes;
 * the editor paints each role with its own theme hue.
 */

const HEADING = new Set([
	"BookCtrlSeq",
	"PartCtrlSeq",
	"ChapterCtrlSeq",
	"SectionCtrlSeq",
	"SubSectionCtrlSeq",
	"SubSubSectionCtrlSeq",
	"ParagraphCtrlSeq",
	"SubParagraphCtrlSeq",
	"TitleCtrlSeq",
	"AuthorCtrlSeq",
	"DateCtrlSeq",
	"MaketitleCtrlSeq",
	"BibliographyCtrlSeq",
	"BibliographyStyleCtrlSeq",
]);

const FORMAT_BOLD = new Set(["TextBoldCtrlSeq"]);

const FORMAT_ITALIC = new Set([
	"TextItalicCtrlSeq",
	"EmphasisCtrlSeq",
	"UnderlineCtrlSeq",
]);

const FORMAT = new Set([
	"TextSmallCapsCtrlSeq",
	"TextTeletypeCtrlSeq",
	"TextMediumCtrlSeq",
	"TextSansSerifCtrlSeq",
	"TextSuperscriptCtrlSeq",
	"TextSubscriptCtrlSeq",
	"TextStrikeOutCtrlSeq",
	"TextColorCtrlSeq",
	"ColorBoxCtrlSeq",
]);

const REFERENCE = new Set([
	"RefCtrlSeq",
	"RefStarrableCtrlSeq",
	"CiteCtrlSeq",
	"CiteStarrableCtrlSeq",
	"LabelCtrlSeq",
	"FootnoteCtrlSeq",
	"EndnoteCtrlSeq",
]);

const STRUCTURE = new Set([
	"DocumentClassCtrlSeq",
	"UsePackageCtrlSeq",
	"NewCommandCtrlSeq",
	"RenewCommandCtrlSeq",
	"NewEnvironmentCtrlSeq",
	"RenewEnvironmentCtrlSeq",
	"DefCtrlSeq",
	"LetCtrlSeq",
	"NewTheoremCtrlSeq",
	"TheoremStyleCtrlSeq",
	"SetLengthCtrlSeq",
]);

const LINK = new Set(["HrefCtrlSeq", "UrlCtrlSeq"]);

const MATH = new Set([
	"Dollar",
	"Math",
	"MathChar",
	"MathSpecialChar",
	"MathOpening",
	"MathClosing",
	"MathDelimiter",
	"MathTextCtrlSeq",
	"LeftCtrlSeq",
	"RightCtrlSeq",
]);

/** CSS class for one syntax-tree node, or null when the generic highlighter is enough. */
export function texTokenClass(name: string): string | null {
	if (HEADING.has(name)) return "cm-tex-heading";
	if (FORMAT_BOLD.has(name)) return "cm-tex-format cm-tex-format-bold";
	if (FORMAT_ITALIC.has(name)) return "cm-tex-format cm-tex-format-italic";
	if (FORMAT.has(name)) return "cm-tex-format";
	if (REFERENCE.has(name)) return "cm-tex-ref";
	if (name === "Begin" || name === "End" || name.endsWith("EnvName"))
		return "cm-tex-env";
	if (STRUCTURE.has(name)) return "cm-tex-structure";
	if (LINK.has(name)) return "cm-tex-link";
	if (MATH.has(name)) return "cm-tex-math";
	if (name.endsWith("CtrlSeq") || name === "Csname") return "cm-tex-cmd";
	return null;
}
