import {
	DefenseOutputValidationError,
	DefenseProviderDiagnosticError,
	type EvidenceRef,
	extractDefenseProviderDiagnostic,
	extractEmbeddedJsonObject,
	isSafeVaultRelativePath,
} from "@/lib/voice-defense/preparation/schema";

export const DEFENSE_REVIEW_SCHEMA_VERSION = 1 as const;

export type DefenseTurnVerdict = "strong" | "adequate" | "weak" | "incorrect";
export type DefenseOverall = "strong" | "adequate" | "weak";

export type DefenseReviewTurn = {
	question: string;
	answer: string;
	verdict: DefenseTurnVerdict;
	factualErrors: string[];
	notes: string;
	evidence: EvidenceRef[];
};

export type DefenseSessionReview = {
	schemaVersion: typeof DEFENSE_REVIEW_SCHEMA_VERSION;
	kind: "session-review";
	summary: string;
	overall: DefenseOverall;
	turns: DefenseReviewTurn[];
	weakAreas: string[];
	suggestedMaterials: string[];
	sources: EvidenceRef[];
	warnings: string[];
};

const VERDICTS: readonly DefenseTurnVerdict[] = [
	"strong",
	"adequate",
	"weak",
	"incorrect",
];
const OVERALL: readonly DefenseOverall[] = ["strong", "adequate", "weak"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new DefenseOutputValidationError(
			`${field} must be a non-empty string`,
		);
	}
	return value;
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new DefenseOutputValidationError(`${field} must be a string array`);
	}
	return value;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function parseEvidence(
	value: unknown,
	field: string,
	allowedSources: ReadonlySet<string>,
): EvidenceRef {
	if (!isRecord(value)) {
		throw new DefenseOutputValidationError(`${field} must be an object`);
	}
	const path = normalizePath(requiredString(value.path, `${field}.path`));
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
		section: typeof value.section === "string" ? value.section : undefined,
		figure: typeof value.figure === "string" ? value.figure : undefined,
		quote: typeof value.quote === "string" ? value.quote : undefined,
		confidence,
	};
}

function evidenceArray(
	value: unknown,
	field: string,
	allowedSources: ReadonlySet<string>,
): EvidenceRef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new DefenseOutputValidationError(`${field} must be an array`);
	}
	return value.map((item, index) =>
		parseEvidence(item, `${field}[${index}]`, allowedSources),
	);
}

function parseJsonObject(rawOutput: string): Record<string, unknown> {
	const trimmed = rawOutput.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const json = fenced ? fenced[1] : trimmed;
	const providerDiagnostic = extractDefenseProviderDiagnostic(trimmed);
	if (providerDiagnostic) {
		throw new DefenseProviderDiagnosticError(providerDiagnostic);
	}
	try {
		const parsed = JSON.parse(json) as unknown;
		if (isRecord(parsed)) return parsed;
	} catch {
		const embedded = extractEmbeddedJsonObject(
			trimmed,
			(parsed) =>
				parsed.schemaVersion === DEFENSE_REVIEW_SCHEMA_VERSION &&
				parsed.kind === "session-review",
		);
		if (embedded) {
			return embedded;
		}
	}
	throw new DefenseOutputValidationError("agent output is not valid JSON");
}

export function parseDefenseSessionReview(
	rawOutput: string,
	allowedSourcePaths: Iterable<string>,
): DefenseSessionReview {
	const value = parseJsonObject(rawOutput);
	if (value.schemaVersion !== DEFENSE_REVIEW_SCHEMA_VERSION) {
		throw new DefenseOutputValidationError("schemaVersion must be 1");
	}
	if (value.kind !== "session-review") {
		throw new DefenseOutputValidationError("kind must be session-review");
	}
	const allowedSources = new Set(
		[...allowedSourcePaths].map((path) => normalizePath(path)),
	);
	if (!Array.isArray(value.turns) || value.turns.length === 0) {
		throw new DefenseOutputValidationError("turns must be a non-empty array");
	}
	const overall = value.overall;
	if (
		typeof overall !== "string" ||
		!OVERALL.includes(overall as DefenseOverall)
	) {
		throw new DefenseOutputValidationError("overall is unsupported");
	}
	const turns = value.turns.map((turn, index) => {
		if (!isRecord(turn)) {
			throw new DefenseOutputValidationError(
				`turns[${index}] must be an object`,
			);
		}
		if (
			typeof turn.verdict !== "string" ||
			!VERDICTS.includes(turn.verdict as DefenseTurnVerdict)
		) {
			throw new DefenseOutputValidationError(
				`turns[${index}].verdict is unsupported`,
			);
		}
		return {
			question: requiredString(turn.question, `turns[${index}].question`),
			answer: requiredString(turn.answer, `turns[${index}].answer`),
			verdict: turn.verdict as DefenseTurnVerdict,
			factualErrors: stringArray(
				turn.factualErrors ?? [],
				`turns[${index}].factualErrors`,
			),
			notes: requiredString(turn.notes, `turns[${index}].notes`),
			evidence: evidenceArray(
				turn.evidence ?? [],
				`turns[${index}].evidence`,
				allowedSources,
			),
		};
	});
	return {
		schemaVersion: DEFENSE_REVIEW_SCHEMA_VERSION,
		kind: "session-review",
		summary: requiredString(value.summary, "summary"),
		overall: overall as DefenseOverall,
		turns,
		weakAreas: stringArray(value.weakAreas ?? [], "weakAreas"),
		suggestedMaterials: stringArray(
			value.suggestedMaterials ?? [],
			"suggestedMaterials",
		),
		sources: evidenceArray(value.sources ?? [], "sources", allowedSources),
		warnings: stringArray(value.warnings ?? [], "warnings"),
	};
}
