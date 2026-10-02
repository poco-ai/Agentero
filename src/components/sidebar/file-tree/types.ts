import type { PaperLibraryRow } from "@/lib/paper";
import type { PlazaSource } from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";

export type TreeCreateKind = "file" | "folder";

export type TreeCreateDraft = {
	kind: TreeCreateKind;
	/** Absolute path of the parent directory (vault root or folder). */
	parentPath: string;
};

export type TreeRenameDraft = {
	/** Absolute path of the file/folder being renamed. */
	path: string;
	/** Current disk name (basename). */
	currentName: string;
};

/** One flattened, windowable tree row in display order. */
export type FlatRow =
	| { key: string; kind: "trash" }
	| { key: string; kind: "plaza" }
	| { key: string; kind: "plazaSource"; source: PlazaSource }
	| {
			key: string;
			kind: "zoteroCollectionReference";
			depth: number;
			paper: PaperLibraryRow;
			path: string;
	  }
	| { key: string; kind: "create"; depth: number }
	| {
			key: string;
			kind: "node";
			depth: number;
			node: FileNode;
			paperLeaf: boolean;
	  };

export type TreeContextMenu = {
	path: string;
	x: number;
	y: number;
};
