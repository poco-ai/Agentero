export {
	paperAssetDownloadReasons,
	paperHasLocalPaperMd,
	paperHasLocalPdf,
	paperHasLocalTex,
	paperNeedsAssetDownload,
	paperNeedsRead,
} from "@/lib/paper/assets";
export {
	isPaperAttachmentsRoot,
	isUnderPaperAttachments,
	paperAttachmentChildren,
	paperAttachmentsNode,
	paperHasVisibleAttachments,
} from "@/lib/paper/attachments";
export {
	collectPaperFoldersFromTree,
	detectPaperDirectory,
	directoryHasPaperMarkers,
	isPaperDirectory,
	paperDirFromPath,
	resolvePapersParentDir,
} from "@/lib/paper/detect";
export {
	loadPaperMetadata,
	loadPaperOpenBundle,
	type PaperOpenBundle,
	paperCatalogPath,
} from "@/lib/paper/load-meta";
export {
	canAttemptPdfDownload,
	canonicalPaperPdfPath,
	findCanonicalPaperPdfPath,
	findLocalPdfPath,
	isPdfViewerSource,
	localFileToArrayBuffer,
	localImageToViewerSource,
	paperRemoteAssetsFromMetadata,
	revokePdfViewerSource,
} from "@/lib/paper/media";
export {
	attachmentsPathForPaper,
	isPaperAssetPath,
	isPaperAttachmentsDirName,
	isPaperInternalDirName,
	isPapersRoot,
	isUnderPapers,
	notesPathForPaper,
	PAPER_ATTACHMENTS_DIR,
	PAPER_INTERNAL_DIR_NAMES,
} from "@/lib/paper/paths";
export {
	formatPublicationDate,
	isPublicationDateInput,
	type PublicationDate,
	parsePublicationDate,
	publicationDateSortKey,
	publicationDateText,
} from "@/lib/paper/publication-date";
export {
	getRemoteArxivPaper,
	getRemoteArxivPaperByPath,
	isRemoteArxivPath,
	REMOTE_ARXIV_PREFIX,
	type RemotePaperItem,
	remoteArxivIdFromPath,
	remoteArxivPath,
	stageRemoteArxivPaper,
} from "@/lib/paper/remote-paper";
export {
	hasTitleMath,
	parseTitleMath,
	type TitleMathSegment,
} from "@/lib/paper/title-math";
export {
	formatAuthorsShort,
	formatPaperTreeLabel,
	PAPER_TREE_LABEL_MODES,
	PAPER_TREE_SORT_MODES,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
	sortFileTreeNodes,
} from "@/lib/paper/tree-label";
export type {
	PaperLibraryRow,
	PaperMetadata,
	PaperTag,
} from "@/lib/paper/types";
