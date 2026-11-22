export type UpdatePhase =
	| "unsupported"
	| "idle"
	| "checking"
	| "up-to-date"
	| "available"
	| "downloading"
	| "installing"
	| "error";

export type UpdateOperation = "check" | "install";

export type ChangelogView =
	| { kind: "release"; version: string }
	| { kind: "history"; currentVersion?: string };

export type UpdateSnapshot = {
	phase: UpdatePhase;
	currentVersion?: string;
	availableVersion?: string;
	notes?: string;
	downloadedBytes?: number;
	totalBytes?: number;
	errorOperation?: UpdateOperation;
};
