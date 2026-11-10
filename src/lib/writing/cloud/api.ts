import { tauriFetch } from "tauri-plugin-better-auth/client";
import { z } from "zod";
import { accountApiOrigin } from "@/features/account/client";
import {
	type WritingSessionTicket,
	writingId,
	writingRole,
} from "./protocol/contracts";

export class WritingApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const projectSchema = z.object({
	id: writingId,
	name: z.string(),
	role: writingRole,
	status: z.enum(["active", "provisioning", "archived"]),
});

const sessionSchema = z.object({
	serverUrl: z.url(),
	websocketUrl: z.url(),
	token: z.string().min(1),
	role: writingRole,
	docEpoch: z.literal(1),
	expiresAt: z.number(),
});

const assetSchema = z.object({
	assetVersionId: writingId,
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	size: z.number().int().nonnegative(),
});

export type CloudProject = z.infer<typeof projectSchema>;

async function account<T>(
	path: string,
	schema: z.ZodType<T>,
	body?: object,
): Promise<T> {
	const response = await tauriFetch(
		`${accountApiOrigin}/api/writing/${path}`,
		body
			? {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}
			: undefined,
	);
	const result = await response.json().catch(() => null);
	if (!response.ok || !result?.ok) {
		throw new WritingApiError(
			response.status,
			result?.error?.message ?? `Writing API (${response.status})`,
		);
	}
	return schema.parse(result.data);
}

export const listCloudProjects = () =>
	account("projects", z.array(projectSchema));
export const provisionCloudProject = (id: string, name: string) =>
	account("projects", projectSchema, { id, name });
export async function issueCloudTicket(
	id: string,
): Promise<WritingSessionTicket> {
	const ticket = await account(`projects/${id}/session`, sessionSchema, {});
	const service = new URL(ticket.serverUrl);
	const ws = new URL(ticket.websocketUrl);
	const local =
		service.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]"].includes(service.hostname) &&
		import.meta.env.DEV;
	if (
		(!local && service.protocol !== "https:") ||
		ws.protocol !== (local ? "ws:" : "wss:") ||
		ws.host !== service.host ||
		service.username ||
		service.password ||
		service.search ||
		service.hash ||
		ws.username ||
		ws.password ||
		ws.search ||
		ws.hash
	)
		throw new Error("Invalid writing service URL");
	return ticket;
}

export async function contentRequest(
	ticket: WritingSessionTicket,
	id: string,
	path: string,
	init?: RequestInit,
) {
	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${ticket.token}`);
	const response = await fetch(
		`${ticket.serverUrl}/v1/projects/${id}/${path}`,
		{
			...init,
			headers,
			redirect: "error",
			signal: init?.signal ?? AbortSignal.timeout(50_000),
		},
	);
	if (!response.ok) {
		const result = await response.json().catch(() => null);
		throw new WritingApiError(
			response.status,
			result?.error ?? `Writing service (${response.status})`,
		);
	}
	return response;
}

export async function uploadWritingAsset(
	ticket: WritingSessionTicket,
	id: string,
	data: Uint8Array,
) {
	const response = await contentRequest(ticket, id, "assets", {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: new Uint8Array(data),
	});
	return assetSchema.parse(await response.json());
}
