#!/usr/bin/env node

/**
 * Summarise a human-scored, fixed-corpus Voice defense quality study.
 *
 * The preparation pipeline deliberately does not upload telemetry or choose a
 * quality winner automatically. This small, local-only tool turns the scores
 * collected by a reviewer into a reproducible comparison report.
 *
 * Usage:
 *   node scripts/evaluate-voice-defense.mjs --init docs/development/voice-defense-study.json
 *   node scripts/evaluate-voice-defense.mjs --study docs/development/voice-defense-study.json
 *   node scripts/evaluate-voice-defense.mjs --study ... --out .../report.md
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const REQUIRED_COVERAGE = [
	"researchProblem",
	"method",
	"experiments",
	"conclusions",
	"limitations",
];
const VARIANTS = ["single-agent", "multi-agent"];
const DEFAULT_THRESHOLDS = {
	minimumPapers: 3,
	minimumCoverageGain: 0.1,
	maximumUnsupportedIncrease: 0.02,
	maximumLatencyIncreaseRatio: 0.05,
	maximumLatencyIncreaseMs: 200,
	minimumSuccessRate: 0.8,
};

export function createStudyTemplate() {
	return {
		schemaVersion: SCHEMA_VERSION,
		studyId: "voice-defense-quality-2026-01",
		papers: [
			{
				id: "paper-1",
				title: "Replace with a paper from the fixed corpus",
				variants: {
					"single-agent": createVariantTemplate(),
					"multi-agent": createVariantTemplate(),
				},
			},
		],
		thresholds: { ...DEFAULT_THRESHOLDS },
		decision: {
			outcome: "needs-more-data",
			rationale: "Fill this after reviewing the generated report.",
		},
	};
}

function createVariantTemplate() {
	return {
		status: "completed",
		durationMs: null,
		coverage: Object.fromEntries(REQUIRED_COVERAGE.map((key) => [key, false])),
		evidence: { checked: 0, accurate: 0 },
		unsupportedClaims: { checked: 0, unsupported: 0 },
		questions: { checked: 0, distinct: 0, answerable: 0 },
		generatedTextPath: null,
		reviewedTextPath: null,
		voice: { firstQuestionMs: null, medianTurnMs: null },
	};
}

function fail(message) {
	throw new Error(`voice-defense evaluation: ${message}`);
}

function record(value, field) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(`${field} must be an object`);
	}
	return value;
}

function nonNegativeNumber(value, field, { nullable = false } = {}) {
	if (nullable && value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		fail(`${field} must be a non-negative number${nullable ? " or null" : ""}`);
	}
	return value;
}

function countPair(value, field, numeratorName) {
	const pair = record(value, field);
	const checked = nonNegativeNumber(pair.checked, `${field}.checked`);
	const numerator = nonNegativeNumber(
		pair[numeratorName],
		`${field}.${numeratorName}`,
	);
	if (!Number.isInteger(checked) || !Number.isInteger(numerator)) {
		fail(`${field}.checked and ${numeratorName} must be integers`);
	}
	if (numerator > checked)
		fail(`${field}.${numeratorName} cannot exceed checked`);
	return { checked, [numeratorName]: numerator };
}

function coverageRatio(value, field) {
	const coverage = record(value, field);
	const missing = REQUIRED_COVERAGE.filter(
		(key) => typeof coverage[key] !== "boolean",
	);
	if (missing.length)
		fail(`${field} is missing boolean keys: ${missing.join(", ")}`);
	return (
		REQUIRED_COVERAGE.reduce((sum, key) => sum + (coverage[key] ? 1 : 0), 0) /
		REQUIRED_COVERAGE.length
	);
}

function tokenize(text) {
	return text.match(/[A-Za-z0-9_]+|[^\s]/gu) ?? [];
}

function editRatio(generated, reviewed) {
	const before = tokenize(generated);
	const after = tokenize(reviewed);
	if (!before.length && !after.length) return 0;
	const counts = new Map();
	for (const token of before) counts.set(token, (counts.get(token) ?? 0) + 1);
	let overlap = 0;
	for (const token of after) {
		const remaining = counts.get(token) ?? 0;
		if (remaining > 0) {
			overlap += 1;
			counts.set(token, remaining - 1);
		}
	}
	return 1 - overlap / Math.max(before.length, after.length);
}

function resolveOptionalPath(studyPath, relativePath) {
	if (relativePath === null || relativePath === undefined) return null;
	if (typeof relativePath !== "string" || !relativePath.trim()) {
		fail("text paths must be non-empty strings or null");
	}
	return path.resolve(path.dirname(studyPath), relativePath);
}

async function loadEditRatio(studyPath, variant) {
	const generatedPath = resolveOptionalPath(
		studyPath,
		variant.generatedTextPath,
	);
	const reviewedPath = resolveOptionalPath(studyPath, variant.reviewedTextPath);
	if (!generatedPath && !reviewedPath) return null;
	if (!generatedPath || !reviewedPath) {
		fail("generatedTextPath and reviewedTextPath must be provided together");
	}
	const [generated, reviewed] = await Promise.all([
		readFile(generatedPath, "utf8"),
		readFile(reviewedPath, "utf8"),
	]);
	return editRatio(generated, reviewed);
}

async function normaliseVariant(studyPath, value, paperId, variantName) {
	const variant = record(value, `${paperId}.${variantName}`);
	const status = variant.status;
	if (typeof status !== "string" || !status.trim())
		fail(`${paperId}.${variantName}.status is required`);
	const evidence = countPair(
		variant.evidence,
		`${paperId}.${variantName}.evidence`,
		"accurate",
	);
	const unsupported = countPair(
		variant.unsupportedClaims,
		`${paperId}.${variantName}.unsupportedClaims`,
		"unsupported",
	);
	const questions = record(
		variant.questions,
		`${paperId}.${variantName}.questions`,
	);
	const checkedQuestions = nonNegativeNumber(
		questions.checked,
		`${paperId}.${variantName}.questions.checked`,
	);
	const distinct = nonNegativeNumber(
		questions.distinct,
		`${paperId}.${variantName}.questions.distinct`,
	);
	const answerable = nonNegativeNumber(
		questions.answerable,
		`${paperId}.${variantName}.questions.answerable`,
	);
	if (![checkedQuestions, distinct, answerable].every(Number.isInteger)) {
		fail(`${paperId}.${variantName}.questions counts must be integers`);
	}
	if (distinct > checkedQuestions || answerable > checkedQuestions) {
		fail(`${paperId}.${variantName}.questions counts cannot exceed checked`);
	}
	const voice = record(variant.voice ?? {}, `${paperId}.${variantName}.voice`);
	const firstQuestionMs = nonNegativeNumber(
		voice.firstQuestionMs ?? null,
		`${paperId}.${variantName}.voice.firstQuestionMs`,
		{ nullable: true },
	);
	const medianTurnMs = nonNegativeNumber(
		voice.medianTurnMs ?? null,
		`${paperId}.${variantName}.voice.medianTurnMs`,
		{ nullable: true },
	);
	const durationMs = nonNegativeNumber(
		variant.durationMs ?? null,
		`${paperId}.${variantName}.durationMs`,
		{ nullable: true },
	);
	return {
		status,
		durationMs,
		coverage: coverageRatio(
			variant.coverage,
			`${paperId}.${variantName}.coverage`,
		),
		evidenceAccuracy: evidence.checked
			? evidence.accurate / evidence.checked
			: null,
		unsupportedRatio: unsupported.checked
			? unsupported.unsupported / unsupported.checked
			: null,
		questionDistinctness: checkedQuestions ? distinct / checkedQuestions : null,
		questionAnswerability: checkedQuestions
			? answerable / checkedQuestions
			: null,
		editRatio: await loadEditRatio(studyPath, variant),
		voice: { firstQuestionMs, medianTurnMs },
	};
}

function average(values) {
	const present = values.filter(
		(value) => value !== null && value !== undefined,
	);
	return present.length
		? present.reduce((sum, value) => sum + value, 0) / present.length
		: null;
}

function formatNumber(value, digits = 3) {
	return value === null || value === undefined ? "—" : value.toFixed(digits);
}

function formatRatio(value) {
	return value === null || value === undefined
		? "—"
		: `${(value * 100).toFixed(1)}%`;
}

function delta(multi, single) {
	return multi === null || single === null ? null : multi - single;
}

function aggregate(papers, variantName) {
	const variants = papers.map((paper) => paper.variants[variantName]);
	const successful = variants.filter((variant) =>
		["completed", "ready", "awaiting_review"].includes(variant.status),
	).length;
	return {
		coverage: average(variants.map((variant) => variant.coverage)),
		evidenceAccuracy: average(
			variants.map((variant) => variant.evidenceAccuracy),
		),
		unsupportedRatio: average(
			variants.map((variant) => variant.unsupportedRatio),
		),
		questionDistinctness: average(
			variants.map((variant) => variant.questionDistinctness),
		),
		questionAnswerability: average(
			variants.map((variant) => variant.questionAnswerability),
		),
		editRatio: average(variants.map((variant) => variant.editRatio)),
		durationMs: average(variants.map((variant) => variant.durationMs)),
		firstQuestionMs: average(
			variants.map((variant) => variant.voice.firstQuestionMs),
		),
		medianTurnMs: average(
			variants.map((variant) => variant.voice.medianTurnMs),
		),
		successRate: papers.length ? successful / papers.length : 0,
	};
}

function recommendation(papers, aggregateByVariant, thresholds) {
	if (papers.length < thresholds.minimumPapers) return "insufficient-sample";
	const single = aggregateByVariant["single-agent"];
	const multi = aggregateByVariant["multi-agent"];
	if (multi.successRate < thresholds.minimumSuccessRate)
		return "fallback-single-agent";
	const coverageGain = delta(multi.coverage, single.coverage) ?? 0;
	const unsupportedIncrease =
		delta(multi.unsupportedRatio, single.unsupportedRatio) ?? 0;
	if (unsupportedIncrease > thresholds.maximumUnsupportedIncrease)
		return "add-evidence-checker";
	const latencyExceeded = ["firstQuestionMs", "medianTurnMs"].some((key) => {
		const baseline = single[key];
		const difference = delta(multi[key], baseline);
		if (difference === null || baseline === null) return false;
		return (
			difference >
			Math.max(
				thresholds.maximumLatencyIncreaseMs,
				baseline * thresholds.maximumLatencyIncreaseRatio,
			)
		);
	});
	if (latencyExceeded) return "fallback-single-agent";
	if (coverageGain < thresholds.minimumCoverageGain)
		return "fallback-single-agent";
	return "keep-multi-agent";
}

export async function evaluateStudy(study, { studyPath = process.cwd() } = {}) {
	if (!study || typeof study !== "object" || Array.isArray(study))
		fail("study must be an object");
	if (study.schemaVersion !== SCHEMA_VERSION)
		fail(`unsupported schemaVersion: ${study.schemaVersion}`);
	if (typeof study.studyId !== "string" || !study.studyId.trim())
		fail("studyId is required");
	if (!Array.isArray(study.papers) || !study.papers.length)
		fail("papers must be a non-empty array");
	const papers = [];
	const ids = new Set();
	for (const [index, input] of study.papers.entries()) {
		const paper = record(input, `papers[${index}]`);
		if (typeof paper.id !== "string" || !paper.id.trim())
			fail(`papers[${index}].id is required`);
		if (ids.has(paper.id)) fail(`duplicate paper id: ${paper.id}`);
		ids.add(paper.id);
		const variants = record(paper.variants, `${paper.id}.variants`);
		papers.push({
			id: paper.id,
			title: typeof paper.title === "string" ? paper.title : paper.id,
			variants: {
				"single-agent": await normaliseVariant(
					studyPath,
					variants["single-agent"],
					paper.id,
					"single-agent",
				),
				"multi-agent": await normaliseVariant(
					studyPath,
					variants["multi-agent"],
					paper.id,
					"multi-agent",
				),
			},
		});
	}
	const thresholds = {
		...DEFAULT_THRESHOLDS,
		...record(study.thresholds ?? {}, "thresholds"),
	};
	for (const key of Object.keys(DEFAULT_THRESHOLDS))
		nonNegativeNumber(thresholds[key], `thresholds.${key}`);
	const aggregateByVariant = Object.fromEntries(
		VARIANTS.map((variant) => [variant, aggregate(papers, variant)]),
	);
	return {
		schemaVersion: SCHEMA_VERSION,
		studyId: study.studyId,
		papers,
		aggregate: aggregateByVariant,
		deltas: Object.fromEntries(
			[
				"coverage",
				"evidenceAccuracy",
				"unsupportedRatio",
				"questionDistinctness",
				"questionAnswerability",
				"editRatio",
				"durationMs",
				"firstQuestionMs",
				"medianTurnMs",
			].map((key) => [
				key,
				delta(
					aggregateByVariant["multi-agent"][key],
					aggregateByVariant["single-agent"][key],
				),
			]),
		),
		recommendation: recommendation(papers, aggregateByVariant, thresholds),
		thresholds,
		decision: study.decision ?? null,
	};
}

function metricRow(label, single, multi, formatter = formatRatio) {
	return `| ${label} | ${formatter(single)} | ${formatter(multi)} | ${formatter(delta(multi, single))} |`;
}

export function renderMarkdown(result) {
	const single = result.aggregate["single-agent"];
	const multi = result.aggregate["multi-agent"];
	const lines = [
		`# Voice defense quality study: ${result.studyId}`,
		"",
		"> This report is generated locally from reviewer-supplied scores. It contains aggregate metrics only; no model reasoning is recorded.",
		"",
		`**Recommendation:** \`${result.recommendation}\``,
		`**Papers:** ${result.papers.length}`,
		"",
		"## Aggregate comparison",
		"",
		"| Metric | Single Agent | Multi Agent | Delta (multi − single) |",
		"|---|---:|---:|---:|",
		metricRow("Coverage", single.coverage, multi.coverage),
		metricRow(
			"Evidence accuracy",
			single.evidenceAccuracy,
			multi.evidenceAccuracy,
		),
		metricRow(
			"Unsupported-claim ratio",
			single.unsupportedRatio,
			multi.unsupportedRatio,
		),
		metricRow(
			"Question distinctness",
			single.questionDistinctness,
			multi.questionDistinctness,
		),
		metricRow(
			"Question answerability",
			single.questionAnswerability,
			multi.questionAnswerability,
		),
		metricRow("User edit ratio", single.editRatio, multi.editRatio),
		metricRow(
			"Preparation duration (ms)",
			single.durationMs,
			multi.durationMs,
			(value) => formatNumber(value, 0),
		),
		metricRow(
			"Voice first-question latency (ms)",
			single.firstQuestionMs,
			multi.firstQuestionMs,
			(value) => formatNumber(value, 0),
		),
		metricRow(
			"Voice median-turn latency (ms)",
			single.medianTurnMs,
			multi.medianTurnMs,
			(value) => formatNumber(value, 0),
		),
		metricRow(
			"Successful preparation rate",
			single.successRate,
			multi.successRate,
		),
		"",
		"## Per-paper status",
		"",
		"| Paper | Single status | Multi status | Coverage delta | Evidence delta | Unsupported delta | Edit delta |",
		"|---|---|---|---:|---:|---:|---:|",
		...result.papers.map((paper) => {
			const a = paper.variants["single-agent"];
			const b = paper.variants["multi-agent"];
			return `| ${paper.title.replaceAll("|", "\\|")} | ${a.status} | ${b.status} | ${formatRatio(delta(b.coverage, a.coverage))} | ${formatRatio(delta(b.evidenceAccuracy, a.evidenceAccuracy))} | ${formatRatio(delta(b.unsupportedRatio, a.unsupportedRatio))} | ${formatRatio(delta(b.editRatio, a.editRatio))} |`;
		}),
		"",
		"## Decision record",
		"",
		result.decision
			? `- Outcome: \`${result.decision.outcome ?? "unspecified"}\`\n- Rationale: ${result.decision.rationale ?? "(missing)"}`
			: "- No reviewer decision has been recorded.",
		"",
		"Thresholds used:",
		"",
		...Object.entries(result.thresholds).map(
			([key, value]) => `- \`${key}\` = ${value}`,
		),
		"",
	];
	return `${lines.join("\n")}\n`;
}

async function readJson(filePath) {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		fail(
			`cannot read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function argValue(args, flag) {
	const index = args.indexOf(flag);
	return index === -1 ? null : (args[index + 1] ?? null);
}

async function main() {
	const args = process.argv.slice(2);
	const initPath = argValue(args, "--init");
	if (initPath) {
		await mkdir(path.dirname(path.resolve(initPath)), { recursive: true });
		await writeFile(
			initPath,
			`${JSON.stringify(createStudyTemplate(), null, 2)}\n`,
			{ flag: "wx" },
		);
		console.log(`created ${initPath}`);
		return;
	}
	const studyPath = argValue(args, "--study");
	if (!studyPath) fail("--study is required (or use --init)");
	const absoluteStudyPath = path.resolve(studyPath);
	const result = await evaluateStudy(await readJson(absoluteStudyPath), {
		studyPath: absoluteStudyPath,
	});
	const output = renderMarkdown(result);
	const outPath = argValue(args, "--out");
	if (outPath) {
		await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
		await writeFile(outPath, output, "utf8");
		console.log(`wrote ${outPath}`);
	} else {
		process.stdout.write(output);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
