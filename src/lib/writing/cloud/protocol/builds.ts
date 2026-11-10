import { z } from "zod";
import {
	compilerEngine,
	writingCheckpoint,
	writingId,
	writingPath,
} from "./contracts";

export const buildStatus = z.enum([
	"queued",
	"preparing",
	"running",
	"uploading",
	"succeeded",
	"failed",
	"cancelled",
]);
export const buildArtifactKind = z.enum(["pdf", "log", "synctex"]);
export type BuildArtifactKind = z.infer<typeof buildArtifactKind>;
export const buildDiagnostic = z.object({
	message: z.string(),
	path: writingPath.optional(),
	line: z.number().int().positive().optional(),
});
export const writingBuild = z.object({
	buildId: writingId,
	projectId: writingId,
	attemptId: writingId.nullable(),
	sourceSnapshotId: z.string(),
	checkpoint: writingCheckpoint,
	compiler: compilerEngine,
	toolchainDigest: z.string(),
	status: buildStatus,
	createdAt: z.string(),
	diagnostics: z.array(buildDiagnostic),
	artifacts: z.array(
		z.object({
			kind: buildArtifactKind,
			size: z.number().int().nonnegative(),
			sha256: z.string(),
		}),
	),
});
export type WritingBuild = z.infer<typeof writingBuild>;
export const writingBuilds = z.object({
	builds: z.array(writingBuild),
	lastSuccessfulBuildId: writingId.nullable(),
});
export const requestBuild = z.object({ checkpoint: writingCheckpoint });
export const forwardSync = z.object({
	path: writingPath,
	line: z.number().int().positive(),
});
export const backwardSync = z.object({
	page: z.number().int().positive(),
	x: z.number().finite(),
	y: z.number().finite(),
});
export const syncLocation = forwardSync.extend({
	page: backwardSync.shape.page,
	x: backwardSync.shape.x,
	y: backwardSync.shape.y,
});
export type SyncLocation = z.infer<typeof syncLocation>;
export function buildFinished(status: WritingBuild["status"]) {
	return (
		status === "succeeded" || status === "failed" || status === "cancelled"
	);
}
