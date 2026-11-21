import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { tauriFetch } from "tauri-plugin-better-auth/client";
import { accountApiOrigin, authClient } from "@/features/account/client";
import { accountSurfaceEnabled } from "@/features/account/visibility";

export type Capability = "translation" | "ocr" | "embedding";
export type Spending = { allowCreditOverage: boolean; revision: number };
export type Overview = {
	canManage: boolean;
	spending: Spending;
	capabilities: Array<{
		capability: Capability;
		remaining: number;
		held: number;
		resetAt: number;
		available: boolean;
	}>;
};
export type Operation = {
	operation_id: string;
	capability: Capability;
	status: string;
	billing_status: string;
	error_code: string | null;
	result: {
		segments?: Array<{ id: string; text: string | null; status: string }>;
		pages?: Array<{ page_number: number; markdown: string; status: string }>;
	} | null;
	usage: { free_quantity: number; charged_credit_units: number };
};
export const terminal = (operation: Operation) =>
	["succeeded", "partial", "failed", "cancelled"].includes(operation.status) &&
	operation.billing_status !== "reserved";
export const capabilityPath = (org: string | null) =>
	org
		? `/api/orgs/${encodeURIComponent(org)}/capabilities`
		: "/api/account/capabilities";
export async function capabilityRequest<T>(
	org: string | null,
	path: string,
	init?: RequestInit,
): Promise<T> {
	if (!accountSurfaceEnabled) throw new Error("CAPABILITY_DISABLED");
	const response = await tauriFetch(
		`${accountApiOrigin}${capabilityPath(org)}${path}`,
		init,
	);
	const result = await response.json();
	if (!response.ok || !result.ok)
		throw Object.assign(
			new Error(
				result.error?.message ??
					`Capability request failed (${response.status})`,
			),
			{ code: result.error?.code },
		);
	return result.data;
}
const json = (body: unknown, method = "POST", key?: string): RequestInit => ({
	method,
	headers: {
		"content-type": "application/json",
		...(key ? { "Idempotency-Key": key } : {}),
	},
	body: JSON.stringify(body),
});
export const capabilityKey = (user: string, org: string | null) =>
	["capabilities", user, org] as const;
export const overviewOptions = (user: string, org: string | null) =>
	queryOptions({
		queryKey: capabilityKey(user, org),
		queryFn: () => capabilityRequest<Overview>(org, ""),
		refetchInterval: 30000,
		enabled: accountSurfaceEnabled && !!user,
	});
export const operationOptions = (
	user: string,
	org: string | null,
	id: string | null,
) =>
	queryOptions({
		queryKey: [...capabilityKey(user, org), "operation", id],
		queryFn: () => capabilityRequest<Operation>(org, `/operations/${id}`),
		enabled: accountSurfaceEnabled && !!user && !!id,
		refetchInterval: (query) =>
			query.state.data && terminal(query.state.data) ? false : 3000,
	});
export function useSpending(user: string, org: string | null) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (value: Spending) =>
			capabilityRequest<Spending>(org, "/spending", json(value, "PATCH")),
		onSettled: () =>
			client.invalidateQueries({ queryKey: capabilityKey(user, org) }),
	});
}
export const uploadPdf = async (org: string | null, file: File) => {
	const form = new FormData();
	form.set("file", file);
	return capabilityRequest<{ id: string }>(org, "/files", {
		method: "POST",
		body: form,
	});
};
export const quoteOcr = (org: string | null, fileId: string) =>
	capabilityRequest<{
		id: string;
		quantity: number;
		free_quantity: number;
		credit_units: number;
	}>(org, "/quotes", json({ capability: "ocr", input: { file_id: fileId } }));
export const createOcr = (
	org: string | null,
	fileId: string,
	quoteId: string,
	key: string,
) =>
	capabilityRequest<Operation>(
		org,
		"/ocr/jobs",
		json({ file_id: fileId, billing: { quote_id: quoteId } }, "POST", key),
	);
export const cancelOperation = (org: string | null, id: string) =>
	capabilityRequest<Operation>(org, `/operations/${id}/cancel`, json({}));

// Only request identities are persisted; source text and credentials stay out of localStorage.
export async function hostedTranslation(
	text: string,
	source: string,
	target: string,
): Promise<string> {
	if (!accountSurfaceEnabled) throw new Error("CAPABILITY_DISABLED");
	const session = await authClient.getSession();
	if (!session.data?.user.id) throw new Error("CAPABILITY_SIGN_IN_REQUIRED");
	const body = {
		source_language: source,
		target_language: target,
		segments: [{ id: "text", text }],
	};
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(body)),
	);
	const identity = `agentero:translation:${session.data.user.id}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
	const key = localStorage.getItem(identity) ?? crypto.randomUUID();
	localStorage.setItem(identity, key);
	let operation = await capabilityRequest<Operation>(
		null,
		"/translations",
		json(body, "POST", key),
	);
	for (let attempt = 0; !terminal(operation) && attempt < 20; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		operation = await capabilityRequest<Operation>(
			null,
			`/operations/${operation.operation_id}`,
		);
	}
	if (terminal(operation)) localStorage.removeItem(identity);
	const segment = operation.result?.segments?.[0];
	if (segment?.status === "succeeded" && segment.text) return segment.text;
	throw new Error(
		operation.error_code ??
			`CAPABILITY_OPERATION_PENDING:${operation.operation_id}`,
	);
}
