import { z } from "zod";

export const writingSchemaVersion = 1;
export const writingDocEpoch = 1;
export const writingAudience = "agentero-writing";
export const maxUpdateBytes = 12 * 1024 * 1024;
export const maxProjectFiles = 4000;
export const writingId = z.uuid().transform((id) => id.toLowerCase());
export const writingName = z.string().trim().min(1).max(200);
export const writingRole = z.enum(["owner", "editor", "viewer"]);
export type WritingRole = z.infer<typeof writingRole>;
export const compilerEngine = z.enum(["pdflatex", "xelatex", "lualatex"]);
export type CompilerEngine = z.infer<typeof compilerEngine>;
export const memberRole = writingRole.exclude(["owner"]);

export const validWritingName = (name: string) =>
	name.length > 0 &&
	name.length <= 200 &&
	!name.startsWith(".") &&
	!name.endsWith(".") &&
	name.trim() === name &&
	!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) &&
	!Array.from(name).some(
		(char) => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char),
	) &&
	name.toLowerCase() !== "agentero.project.json";

export const writingPath = z
	.string()
	.max(1024)
	.refine(
		(path) =>
			path.split("/").length <= 64 && path.split("/").every(validWritingName),
		"Invalid project relative path",
	);

const textFile = z.object({
	kind: z.literal("text"),
	path: writingPath,
	text: z.string(),
});
const directory = z.object({ kind: z.literal("directory"), path: writingPath });
const asset = z.object({
	kind: z.literal("asset"),
	path: writingPath,
	assetVersionId: writingId,
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const writingImport = z.object({
	mainFile: writingPath.nullable(),
	compiler: compilerEngine,
	files: z
		.array(z.discriminatedUnion("kind", [textFile, directory, asset]))
		.max(maxProjectFiles),
});
export type WritingImport = z.infer<typeof writingImport>;

export const ticketClaims = z.object({
	sub: z.string().min(1),
	name: z.string().max(200),
	projectId: writingId,
	role: writingRole,
	permissions: z.object({
		edit: z.boolean(),
		compile: z.boolean(),
		manage: z.boolean(),
	}),
	aclVersion: z.number().int().positive(),
	docEpoch: z.literal(writingDocEpoch),
	exp: z.number().int().positive(),
	jti: writingId,
});
export type WritingTicket = z.infer<typeof ticketClaims>;

export const writingCheckpoint = z.object({
	projectId: writingId,
	docEpoch: z.literal(writingDocEpoch),
	serverSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type WritingCheckpoint = z.infer<typeof writingCheckpoint>;
export const durableAck = writingCheckpoint.extend({
	type: z.literal("durableAck"),
	updateHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DurableAck = z.infer<typeof durableAck>;

export type WritingSessionTicket = {
	serverUrl: string;
	websocketUrl: string;
	token: string;
	role: WritingRole;
	docEpoch: number;
	expiresAt: number;
};
