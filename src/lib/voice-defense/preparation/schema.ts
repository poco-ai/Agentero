export const DEFENSE_PREPARATION_SCHEMA_VERSION = 1 as const;

export type DefensePreparationRole =
	| "paper-analysis"
	| "adversarial-review"
	| "synthesis";

export type DefenseArtifactKind = "paper-analysis" | "review" | "defense-brief";

export type DefensePreparationStatus =
	| "created"
	| "snapshotting"
	| "analyzing"
	| "synthesizing"
	| "awaiting_review"
	| "ready"
	| "completed"
	| "failed"
	| "cancelled";

export type DefenseNodeStatus =
	| "pending"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "skipped";

export type EvidenceConfidence = "high" | "medium" | "low";

export type EvidenceRef = {
	path: string;
	page?: number;
	section?: string;
	figure?: string;
	quote?: string;
	confidence: EvidenceConfidence;
};

export type PaperSnapshotSource = {
	path: string;
	kind: "text" | "pdf" | "image" | "data";
	size?: number;
	modifiedAt?: string;
	/** Hashes are collected through the Host file API for local and remote Vaults. */
	sha256?: string;
};

export type DefenseMaterialSnapshot = {
	path: string;
	kind: "file" | "directory";
	title?: string;
};

export type PaperSelectionSnapshot = {
	text: string;
	sourcePath?: string;
	page?: number;
};

export type PaperSnapshot = {
	schemaVersion: typeof DEFENSE_PREPARATION_SCHEMA_VERSION;
	/** Legacy primary path retained so existing persisted runs remain readable. */
	paperPath: string;
	materials: DefenseMaterialSnapshot[];
	instruction: string;
	title?: string;
	metadata: Record<string, string | number | boolean | null>;
	selections: PaperSelectionSnapshot[];
	sources: PaperSnapshotSource[];
	snapshotSha256: string;
	warnings: string[];
	createdAt: string;
};

export type PaperAnalysisSection = {
	topic:
		| "research-problem"
		| "contributions"
		| "method"
		| "assumptions"
		| "experiments"
		| "results"
		| "ablations-robustness-errors"
		| "limitations-future-work"
		| "key-elements";
	heading: string;
	content: string;
	verification: "verified" | "unverified";
	evidence: EvidenceRef[];
};

export type PaperAnalysisOutput = {
	schemaVersion: typeof DEFENSE_PREPARATION_SCHEMA_VERSION;
	kind: "paper-analysis";
	overview: string;
	sections: PaperAnalysisSection[];
	sources: EvidenceRef[];
	warnings: string[];
};

export type DefenseQuestion = {
	category:
		| "motivation"
		| "novelty-related-work"
		| "assumptions"
		| "experimental-validity"
		| "evidence-overclaim"
		| "failures-boundaries-reproducibility";
	difficulty: "basic" | "intermediate" | "advanced";
	question: string;
	rationale: string;
	followUps: string[];
	answerOutline: string;
	verification: "verified" | "unverified";
	evidence: EvidenceRef[];
};

export type AdversarialReviewOutput = {
	schemaVersion: typeof DEFENSE_PREPARATION_SCHEMA_VERSION;
	kind: "review";
	overview: string;
	questions: DefenseQuestion[];
	sources: EvidenceRef[];
	warnings: string[];
};

export type DefenseBriefOutput = {
	schemaVersion: typeof DEFENSE_PREPARATION_SCHEMA_VERSION;
	kind: "defense-brief";
	markdown: string;
	sources: EvidenceRef[];
	warnings: string[];
	partial: boolean;
};

export type DefenseStructuredOutput =
	| PaperAnalysisOutput
	| AdversarialReviewOutput
	| DefenseBriefOutput;

export type DefenseArtifactStatus = "valid" | "partial" | "invalid";

export type DefenseArtifact = {
	schemaVersion: typeof DEFENSE_PREPARATION_SCHEMA_VERSION;
	artifactId: string;
	runId: string;
	taskId: string;
	attempt: number;
	kind: DefenseArtifactKind;
	producer: string;
	contentPath: string;
	contentSha256: string;
	sources: EvidenceRef[];
	status: DefenseArtifactStatus;
	warnings: string[];
	createdAt: string;
	payload?: DefenseStructuredOutput;
	/** Preserved only when structured validation fails; never contains ACP reasoning. */
	rawOutput?: string;
	error?: string;
};

export type DefenseNodeAttempt = {
	attempt: number;
	status: Exclude<DefenseNodeStatus, "pending" | "skipped">;
	startedAt: string;
	finishedAt?: string;
	agentId?: string;
	modelId?: string;
	reasoningEffort?: string;
	sessionId?: string;
	providerSessionId?: string;
	artifactId?: string;
	artifactPath?: string;
	error?: string;
	stopReason?: string;
	usageUsed?: number;
	usageSize?: number;
};

export type DefensePreparationNode = {
	taskId: string;
	role: DefensePreparationRole;
	status: DefenseNodeStatus;
	attempts: DefenseNodeAttempt[];
	artifactId?: string;
	artifactPath?: string;
};

export type DefensePreparationManifest = {
	schemaVersion: typeof DEFENSE_PREPARATION_SCHEMA_VERSION;
	runId: string;
	paperPath: string;
	status: DefensePreparationStatus;
	stale: boolean;
	partial: boolean;
	snapshot: PaperSnapshot;
	nodes: Record<DefensePreparationRole, DefensePreparationNode>;
	briefPath?: string;
	review?: {
		confirmedAt: string;
		edited: boolean;
		completedAt?: string;
	};
	warnings: string[];
	createdAt: string;
	updatedAt: string;
};

export type DefensePreparationSummary = Pick<
	DefensePreparationManifest,
	| "runId"
	| "paperPath"
	| "status"
	| "stale"
	| "partial"
	| "briefPath"
	| "createdAt"
	| "updatedAt"
> & {
	snapshotSha256: string;
	materials: string[];
};

export const REUSABLE_PREPARATION_STATUSES = new Set<DefensePreparationStatus>([
	"awaiting_review",
	"ready",
	"completed",
]);

export function isReusablePreparationStatus(
	status: DefensePreparationStatus,
): boolean {
	return REUSABLE_PREPARATION_STATUSES.has(status);
}

/** Latest matching run whose brief can skip a new multi-Agent preparation. */
export function selectReusablePreparation(
	manifests: readonly DefensePreparationManifest[],
	snapshotSha256: string,
): DefensePreparationManifest | null {
	if (!snapshotSha256) return null;
	return (
		manifests
			.filter(
				(manifest) =>
					isReusablePreparationStatus(manifest.status) &&
					Boolean(manifest.briefPath) &&
					manifest.snapshot.snapshotSha256 === snapshotSha256,
			)
			.sort((left, right) =>
				right.updatedAt.localeCompare(left.updatedAt),
			)[0] ?? null
	);
}

export function selectLatestReusablePreparationForPaper(
	manifests: readonly DefensePreparationManifest[],
	paperPath: string,
): DefensePreparationManifest | null {
	if (!paperPath) return null;
	return (
		manifests
			.filter(
				(manifest) =>
					isReusablePreparationStatus(manifest.status) &&
					Boolean(manifest.briefPath) &&
					(manifest.paperPath === paperPath ||
						manifest.snapshot.materials.some(
							(material) => material.path === paperPath,
						)),
			)
			.sort((left, right) =>
				right.updatedAt.localeCompare(left.updatedAt),
			)[0] ?? null
	);
}

export class DefenseOutputValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DefenseOutputValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
	value: unknown,
	field: string,
	allowEmpty = false,
): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
		throw new DefenseOutputValidationError(
			`${field} must be a non-empty string`,
		);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new DefenseOutputValidationError(`${field} must be a string`);
	}
	return value;
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new DefenseOutputValidationError(`${field} must be a string array`);
	}
	return value;
}

function parseVerification(
	value: unknown,
	field: string,
): "verified" | "unverified" {
	if (value !== "verified" && value !== "unverified") {
		throw new DefenseOutputValidationError(
			`${field} must be verified or unverified`,
		);
	}
	return value;
}

function requireSourceDisclosure(
	sources: EvidenceRef[],
	warnings: string[],
	allowedSources: ReadonlySet<string>,
	field: string,
): void {
	if (allowedSources.size > 0 && sources.length === 0) {
		throw new DefenseOutputValidationError(
			`${field} must include at least one source when the snapshot has citable files`,
		);
	}
	if (allowedSources.size === 0 && warnings.length === 0) {
		throw new DefenseOutputValidationError(
			`${field} must disclose the absence of citable sources in warnings`,
		);
	}
}

function normalizeEvidencePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function isSafeVaultRelativePath(path: string): boolean {
	const normalized = normalizeEvidencePath(path);
	return (
		Boolean(normalized) &&
		!path.startsWith("/") &&
		!path.startsWith("\\") &&
		!normalized.startsWith("/") &&
		!normalized.endsWith("/") &&
		!normalized.split("/").some((part) => part === ".." || part === ".") &&
		!/^([a-zA-Z]:|remote:)/i.test(normalized)
	);
}

function parseEvidence(
	value: unknown,
	field: string,
	allowedSources: ReadonlySet<string>,
): EvidenceRef {
	if (!isRecord(value)) {
		throw new DefenseOutputValidationError(`${field} must be an object`);
	}
	const path = normalizeEvidencePath(
		requiredString(value.path, `${field}.path`),
	);
	if (!isSafeVaultRelativePath(path) || !allowedSources.has(path)) {
		throw new DefenseOutputValidationError(
			`${field}.path is outside the paper snapshot: ${path}`,
		);
	}
	const confidence = value.confidence;
	if (
		confidence !== "high" &&
		confidence !== "medium" &&
		confidence !== "low"
	) {
		throw new DefenseOutputValidationError(
			`${field}.confidence must be high, medium, or low`,
		);
	}
	let page: number | undefined;
	if (value.page !== undefined) {
		if (!Number.isInteger(value.page) || (value.page as number) < 1) {
			throw new DefenseOutputValidationError(
				`${field}.page must be a positive integer`,
			);
		}
		page = value.page as number;
	}
	return {
		path,
		page,
		section: optionalString(value.section, `${field}.section`),
		figure: optionalString(value.figure, `${field}.figure`),
		quote: optionalString(value.quote, `${field}.quote`),
		confidence,
	};
}

function evidenceArray(
	value: unknown,
	field: string,
	allowedSources: ReadonlySet<string>,
): EvidenceRef[] {
	if (!Array.isArray(value)) {
		throw new DefenseOutputValidationError(`${field} must be an array`);
	}
	return value.map((item, index) =>
		parseEvidence(item, `${field}[${index}]`, allowedSources),
	);
}

function embeddedStructuredJsonObject(
	rawOutput: string,
): Record<string, unknown> | undefined {
	const candidates: Record<string, unknown>[] = [];
	let searchFrom = 0;
	while (searchFrom < rawOutput.length) {
		const start = rawOutput.indexOf("{", searchFrom);
		if (start < 0) break;

		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = -1;
		for (let index = start; index < rawOutput.length; index += 1) {
			const character = rawOutput[index];
			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (character === "\\") {
					escaped = true;
				} else if (character === '"') {
					inString = false;
				}
				continue;
			}
			if (character === '"') {
				inString = true;
			} else if (character === "{") {
				depth += 1;
			} else if (character === "}") {
				depth -= 1;
				if (depth === 0) {
					end = index + 1;
					break;
				}
			}
		}

		if (end > start) {
			try {
				const parsed = JSON.parse(rawOutput.slice(start, end)) as unknown;
				if (
					isRecord(parsed) &&
					parsed.schemaVersion === DEFENSE_PREPARATION_SCHEMA_VERSION &&
					typeof parsed.kind === "string"
				) {
					candidates.push(parsed);
				}
			} catch {
				// Continue scanning: ACP diagnostics can contain non-JSON braces.
			}
		}
		searchFrom = start + 1;
	}

	if (candidates.length > 1) {
		throw new DefenseOutputValidationError(
			"agent output contains multiple structured JSON objects",
		);
	}
	return candidates[0];
}

function parseJsonObject(rawOutput: string): Record<string, unknown> {
	const trimmed = rawOutput.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const json = fenced ? fenced[1] : trimmed;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		const embedded = embeddedStructuredJsonObject(trimmed);
		if (embedded) return embedded;
		throw new DefenseOutputValidationError(
			`agent output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new DefenseOutputValidationError(
			"agent output must be a JSON object",
		);
	}
	return parsed;
}

function assertVersion(value: Record<string, unknown>): void {
	if (value.schemaVersion !== DEFENSE_PREPARATION_SCHEMA_VERSION) {
		throw new DefenseOutputValidationError("unsupported schemaVersion");
	}
}

const PAPER_ANALYSIS_TOPICS = [
	"research-problem",
	"contributions",
	"method",
	"assumptions",
	"experiments",
	"results",
	"ablations-robustness-errors",
	"limitations-future-work",
	"key-elements",
] as const;

const REVIEW_CATEGORIES = [
	"motivation",
	"novelty-related-work",
	"assumptions",
	"experimental-validity",
	"evidence-overclaim",
	"failures-boundaries-reproducibility",
] as const;

export function parseDefenseStructuredOutput(
	role: DefensePreparationRole,
	rawOutput: string,
	allowedSourcePaths: Iterable<string>,
): DefenseStructuredOutput {
	const value = parseJsonObject(rawOutput);
	assertVersion(value);
	const allowedSources = new Set(
		[...allowedSourcePaths].map(normalizeEvidencePath),
	);

	if (role === "paper-analysis") {
		if (value.kind !== "paper-analysis") {
			throw new DefenseOutputValidationError("kind must be paper-analysis");
		}
		if (!Array.isArray(value.sections) || value.sections.length === 0) {
			throw new DefenseOutputValidationError(
				"sections must be a non-empty array",
			);
		}
		const sections = value.sections.map((section, index) => {
			if (!isRecord(section)) {
				throw new DefenseOutputValidationError(
					`sections[${index}] must be an object`,
				);
			}
			if (
				typeof section.topic !== "string" ||
				!PAPER_ANALYSIS_TOPICS.includes(
					section.topic as (typeof PAPER_ANALYSIS_TOPICS)[number],
				)
			) {
				throw new DefenseOutputValidationError(
					`sections[${index}].topic is unsupported`,
				);
			}
			return {
				topic: section.topic as PaperAnalysisSection["topic"],
				heading: requiredString(section.heading, `sections[${index}].heading`),
				content: requiredString(section.content, `sections[${index}].content`),
				verification: parseVerification(
					section.verification,
					`sections[${index}].verification`,
				),
				evidence: evidenceArray(
					section.evidence,
					`sections[${index}].evidence`,
					allowedSources,
				),
			};
		});
		for (const [index, section] of sections.entries()) {
			if (
				section.verification === "verified" &&
				section.evidence.length === 0
			) {
				throw new DefenseOutputValidationError(
					`sections[${index}] must have evidence or be marked unverified`,
				);
			}
		}
		const topics = new Set(sections.map((section) => section.topic));
		const missingTopics = PAPER_ANALYSIS_TOPICS.filter(
			(topic) => !topics.has(topic),
		);
		if (missingTopics.length > 0) {
			throw new DefenseOutputValidationError(
				`paper analysis is missing topics: ${missingTopics.join(", ")}`,
			);
		}
		const sources = evidenceArray(value.sources, "sources", allowedSources);
		const warnings = stringArray(value.warnings, "warnings");
		requireSourceDisclosure(
			sources,
			warnings,
			allowedSources,
			"paper analysis",
		);
		return {
			schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
			kind: "paper-analysis",
			overview: requiredString(value.overview, "overview"),
			sections,
			sources,
			warnings,
		};
	}

	if (role === "adversarial-review") {
		if (value.kind !== "review") {
			throw new DefenseOutputValidationError("kind must be review");
		}
		if (!Array.isArray(value.questions) || value.questions.length === 0) {
			throw new DefenseOutputValidationError(
				"questions must be a non-empty array",
			);
		}
		const questions = value.questions.map((question, index) => {
			if (!isRecord(question)) {
				throw new DefenseOutputValidationError(
					`questions[${index}] must be an object`,
				);
			}
			if (
				typeof question.category !== "string" ||
				!REVIEW_CATEGORIES.includes(
					question.category as (typeof REVIEW_CATEGORIES)[number],
				)
			) {
				throw new DefenseOutputValidationError(
					`questions[${index}].category is unsupported`,
				);
			}
			if (
				question.difficulty !== "basic" &&
				question.difficulty !== "intermediate" &&
				question.difficulty !== "advanced"
			) {
				throw new DefenseOutputValidationError(
					`questions[${index}].difficulty is unsupported`,
				);
			}
			return {
				category: question.category as DefenseQuestion["category"],
				difficulty: question.difficulty as DefenseQuestion["difficulty"],
				question: requiredString(
					question.question,
					`questions[${index}].question`,
				),
				rationale: requiredString(
					question.rationale,
					`questions[${index}].rationale`,
				),
				followUps: stringArray(
					question.followUps,
					`questions[${index}].followUps`,
				),
				answerOutline: requiredString(
					question.answerOutline,
					`questions[${index}].answerOutline`,
				),
				verification: parseVerification(
					question.verification,
					`questions[${index}].verification`,
				),
				evidence: evidenceArray(
					question.evidence,
					`questions[${index}].evidence`,
					allowedSources,
				),
			};
		});
		for (const [index, question] of questions.entries()) {
			if (
				question.verification === "verified" &&
				question.evidence.length === 0
			) {
				throw new DefenseOutputValidationError(
					`questions[${index}] must have evidence or be marked unverified`,
				);
			}
		}
		for (const [index, question] of questions.entries()) {
			if (question.followUps.length === 0) {
				throw new DefenseOutputValidationError(
					`questions[${index}].followUps must contain at least one follow-up`,
				);
			}
		}
		const categories = new Set(questions.map((question) => question.category));
		const missingCategories = REVIEW_CATEGORIES.filter(
			(category) => !categories.has(category),
		);
		if (missingCategories.length > 0) {
			throw new DefenseOutputValidationError(
				`adversarial review is missing categories: ${missingCategories.join(", ")}`,
			);
		}
		const difficulties = new Set(
			questions.map((question) => question.difficulty),
		);
		if (!difficulties.has("basic") || !difficulties.has("advanced")) {
			throw new DefenseOutputValidationError(
				"adversarial review must include both basic and advanced questions",
			);
		}
		const sources = evidenceArray(value.sources, "sources", allowedSources);
		const warnings = stringArray(value.warnings, "warnings");
		requireSourceDisclosure(
			sources,
			warnings,
			allowedSources,
			"adversarial review",
		);
		return {
			schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
			kind: "review",
			overview: requiredString(value.overview, "overview"),
			questions,
			sources,
			warnings,
		};
	}

	if (value.kind !== "defense-brief") {
		throw new DefenseOutputValidationError("kind must be defense-brief");
	}
	if (typeof value.partial !== "boolean") {
		throw new DefenseOutputValidationError("partial must be a boolean");
	}
	const sources = evidenceArray(value.sources, "sources", allowedSources);
	const warnings = stringArray(value.warnings, "warnings");
	requireSourceDisclosure(sources, warnings, allowedSources, "defense brief");
	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		kind: "defense-brief",
		markdown: requiredString(value.markdown, "markdown"),
		sources,
		warnings,
		partial: value.partial,
	};
}

function isNodeStatus(value: unknown): value is DefenseNodeStatus {
	return (
		value === "pending" ||
		value === "running" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "skipped"
	);
}

function isPreparationStatus(
	value: unknown,
): value is DefensePreparationStatus {
	return (
		value === "created" ||
		value === "snapshotting" ||
		value === "analyzing" ||
		value === "synthesizing" ||
		value === "awaiting_review" ||
		value === "ready" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function isRole(value: unknown): value is DefensePreparationRole {
	return (
		value === "paper-analysis" ||
		value === "adversarial-review" ||
		value === "synthesis"
	);
}

function isArtifactKind(value: unknown): value is DefenseArtifactKind {
	return (
		value === "paper-analysis" ||
		value === "review" ||
		value === "defense-brief"
	);
}

function isArtifactStatus(value: unknown): value is DefenseArtifactStatus {
	return value === "valid" || value === "partial" || value === "invalid";
}

function isHexSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseDiskEvidence(value: unknown): EvidenceRef | null {
	if (!isRecord(value) || typeof value.path !== "string") return null;
	const path = normalizeEvidencePath(value.path);
	if (!isSafeVaultRelativePath(path)) return null;
	if (
		value.confidence !== "high" &&
		value.confidence !== "medium" &&
		value.confidence !== "low"
	) {
		return null;
	}
	if (
		value.page !== undefined &&
		(!Number.isInteger(value.page) || (value.page as number) < 1)
	) {
		return null;
	}
	for (const key of ["section", "figure", "quote"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return null;
	}
	return {
		path,
		page: value.page as number | undefined,
		section: value.section as string | undefined,
		figure: value.figure as string | undefined,
		quote: value.quote as string | undefined,
		confidence: value.confidence,
	};
}

function parseDiskEvidenceArray(value: unknown): EvidenceRef[] | null {
	if (!Array.isArray(value)) return null;
	const parsed = value.map(parseDiskEvidence);
	return parsed.some((item) => item === null)
		? null
		: (parsed as EvidenceRef[]);
}

function parseSnapshot(value: unknown): PaperSnapshot | null {
	if (!isRecord(value)) return null;
	if (
		value.schemaVersion !== DEFENSE_PREPARATION_SCHEMA_VERSION ||
		typeof value.paperPath !== "string" ||
		!isSafeVaultRelativePath(value.paperPath) ||
		(value.title !== undefined && typeof value.title !== "string") ||
		!isRecord(value.metadata) ||
		!Array.isArray(value.selections) ||
		!Array.isArray(value.sources) ||
		!isHexSha256(value.snapshotSha256) ||
		!Array.isArray(value.warnings) ||
		value.warnings.some((item) => typeof item !== "string") ||
		typeof value.createdAt !== "string"
	) {
		return null;
	}
	for (const metadataValue of Object.values(value.metadata)) {
		if (
			metadataValue !== null &&
			typeof metadataValue !== "string" &&
			typeof metadataValue !== "number" &&
			typeof metadataValue !== "boolean"
		) {
			return null;
		}
	}
	const selections: PaperSelectionSnapshot[] = [];
	for (const selection of value.selections) {
		if (
			!isRecord(selection) ||
			typeof selection.text !== "string" ||
			(selection.sourcePath !== undefined &&
				(typeof selection.sourcePath !== "string" ||
					!isSafeVaultRelativePath(selection.sourcePath))) ||
			(selection.page !== undefined &&
				(!Number.isInteger(selection.page) || (selection.page as number) < 1))
		) {
			return null;
		}
		selections.push({
			text: selection.text,
			sourcePath: selection.sourcePath as string | undefined,
			page: selection.page as number | undefined,
		});
	}
	const sources: PaperSnapshotSource[] = [];
	for (const source of value.sources) {
		if (
			!isRecord(source) ||
			typeof source.path !== "string" ||
			!isSafeVaultRelativePath(source.path) ||
			(source.kind !== "text" &&
				source.kind !== "pdf" &&
				source.kind !== "image" &&
				source.kind !== "data") ||
			(source.size !== undefined &&
				(!Number.isInteger(source.size) || (source.size as number) < 0)) ||
			(source.modifiedAt !== undefined &&
				typeof source.modifiedAt !== "string") ||
			(source.sha256 !== undefined && !isHexSha256(source.sha256))
		) {
			return null;
		}
		sources.push({
			path: source.path,
			kind: source.kind,
			size: source.size as number | undefined,
			modifiedAt: source.modifiedAt as string | undefined,
			sha256: source.sha256 as string | undefined,
		});
	}
	const materials: DefenseMaterialSnapshot[] = [];
	if (value.materials !== undefined) {
		if (!Array.isArray(value.materials) || value.materials.length === 0) {
			return null;
		}
		for (const material of value.materials) {
			if (
				!isRecord(material) ||
				typeof material.path !== "string" ||
				!isSafeVaultRelativePath(material.path) ||
				(material.kind !== "file" && material.kind !== "directory") ||
				(material.title !== undefined && typeof material.title !== "string")
			) {
				return null;
			}
			materials.push({
				path: material.path,
				kind: material.kind,
				title: material.title as string | undefined,
			});
		}
	} else {
		materials.push({ path: value.paperPath, kind: "directory" });
	}
	if (
		value.instruction !== undefined &&
		typeof value.instruction !== "string"
	) {
		return null;
	}
	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		paperPath: value.paperPath,
		materials,
		instruction: (value.instruction as string | undefined) ?? "",
		title: value.title as string | undefined,
		metadata: value.metadata as PaperSnapshot["metadata"],
		selections,
		sources,
		snapshotSha256: value.snapshotSha256,
		warnings: [...value.warnings] as string[],
		createdAt: value.createdAt,
	};
}

function parseNodeAttempt(value: unknown): DefenseNodeAttempt | null {
	if (
		!isRecord(value) ||
		!Number.isInteger(value.attempt) ||
		(value.attempt as number) < 1 ||
		(value.status !== "running" &&
			value.status !== "succeeded" &&
			value.status !== "failed" &&
			value.status !== "cancelled") ||
		typeof value.startedAt !== "string"
	) {
		return null;
	}
	for (const key of [
		"finishedAt",
		"agentId",
		"modelId",
		"reasoningEffort",
		"sessionId",
		"providerSessionId",
		"artifactId",
		"artifactPath",
		"error",
		"stopReason",
	] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return null;
	}
	for (const key of ["usageUsed", "usageSize"] as const) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== "number" ||
				!Number.isFinite(value[key]) ||
				(value[key] as number) < 0)
		) {
			return null;
		}
	}
	if (value.status !== "running" && typeof value.finishedAt !== "string") {
		return null;
	}
	if (
		value.status === "succeeded" &&
		(typeof value.artifactId !== "string" ||
			typeof value.artifactPath !== "string")
	) {
		return null;
	}
	if (
		value.artifactPath !== undefined &&
		!isSafeVaultRelativePath(value.artifactPath as string)
	) {
		return null;
	}
	return value as DefenseNodeAttempt;
}

export function parseDefenseArtifact(value: unknown): DefenseArtifact | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== DEFENSE_PREPARATION_SCHEMA_VERSION ||
		typeof value.artifactId !== "string" ||
		typeof value.runId !== "string" ||
		!/^[a-zA-Z0-9._-]+$/.test(value.runId) ||
		typeof value.taskId !== "string" ||
		!Number.isInteger(value.attempt) ||
		(value.attempt as number) < 1 ||
		!isArtifactKind(value.kind) ||
		typeof value.producer !== "string" ||
		typeof value.contentPath !== "string" ||
		!isSafeVaultRelativePath(value.contentPath) ||
		!isHexSha256(value.contentSha256) ||
		!isArtifactStatus(value.status) ||
		!Array.isArray(value.warnings) ||
		value.warnings.some((item) => typeof item !== "string") ||
		typeof value.createdAt !== "string" ||
		(value.rawOutput !== undefined && typeof value.rawOutput !== "string") ||
		(value.error !== undefined && typeof value.error !== "string")
	) {
		return null;
	}
	const sources = parseDiskEvidenceArray(value.sources);
	if (!sources) return null;
	return { ...value, sources } as DefenseArtifact;
}

/** Defensive disk parser. Detailed artifact validation happens before writes. */
export function parseDefensePreparationManifest(
	value: unknown,
): DefensePreparationManifest | null {
	if (!isRecord(value)) return null;
	if (value.schemaVersion !== DEFENSE_PREPARATION_SCHEMA_VERSION) return null;
	if (
		typeof value.runId !== "string" ||
		!/^[a-zA-Z0-9._-]+$/.test(value.runId) ||
		typeof value.paperPath !== "string" ||
		!isPreparationStatus(value.status) ||
		typeof value.stale !== "boolean" ||
		typeof value.partial !== "boolean" ||
		!isRecord(value.snapshot) ||
		!isRecord(value.nodes) ||
		!Array.isArray(value.warnings) ||
		value.warnings.some((item) => typeof item !== "string") ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string"
	) {
		return null;
	}
	if (!isSafeVaultRelativePath(value.paperPath)) return null;
	if (
		value.briefPath !== undefined &&
		(typeof value.briefPath !== "string" ||
			!isSafeVaultRelativePath(value.briefPath))
	) {
		return null;
	}
	if (value.review !== undefined) {
		if (
			!isRecord(value.review) ||
			typeof value.review.confirmedAt !== "string" ||
			typeof value.review.edited !== "boolean" ||
			(value.review.completedAt !== undefined &&
				typeof value.review.completedAt !== "string")
		) {
			return null;
		}
	}
	const snapshot = parseSnapshot(value.snapshot);
	if (!snapshot || snapshot.paperPath !== value.paperPath) return null;
	const roles: DefensePreparationRole[] = [
		"paper-analysis",
		"adversarial-review",
		"synthesis",
	];
	const nodes = {} as DefensePreparationManifest["nodes"];
	for (const role of roles) {
		const node = value.nodes[role];
		if (
			!isRecord(node) ||
			typeof node.taskId !== "string" ||
			!isRole(node.role) ||
			node.role !== role ||
			!isNodeStatus(node.status) ||
			!Array.isArray(node.attempts)
		) {
			return null;
		}
		const attempts = node.attempts.map(parseNodeAttempt);
		if (attempts.some((attempt) => attempt === null)) return null;
		const attemptNumbers = new Set<number>();
		for (const attempt of attempts as DefenseNodeAttempt[]) {
			if (attemptNumbers.has(attempt.attempt)) return null;
			attemptNumbers.add(attempt.attempt);
		}
		if (
			(node.artifactId !== undefined && typeof node.artifactId !== "string") ||
			(node.artifactPath !== undefined &&
				(typeof node.artifactPath !== "string" ||
					!isSafeVaultRelativePath(node.artifactPath)))
		) {
			return null;
		}
		nodes[role] = {
			taskId: node.taskId,
			role,
			status: node.status,
			attempts: attempts as DefenseNodeAttempt[],
			artifactId: node.artifactId as string | undefined,
			artifactPath: node.artifactPath as string | undefined,
		};
	}
	const runPrefix = `voice-defense/preparations/${value.runId}/`;
	if (value.briefPath && !value.briefPath.startsWith(runPrefix)) return null;
	for (const role of roles) {
		const node = nodes[role];
		if (
			node.artifactPath &&
			!node.artifactPath.startsWith(`${runPrefix}artifacts/`)
		) {
			return null;
		}
		if (
			node.status === "succeeded" &&
			(!node.artifactId || !node.artifactPath)
		) {
			return null;
		}
	}
	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		runId: value.runId,
		paperPath: value.paperPath,
		status: value.status,
		stale: value.stale,
		partial: value.partial,
		snapshot,
		nodes,
		briefPath: value.briefPath as string | undefined,
		review: value.review as DefensePreparationManifest["review"],
		warnings: [...value.warnings] as string[],
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}
