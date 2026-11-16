import { useQuery } from "@tanstack/react-query";
import { CircleHelp } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { accountWebOrigin } from "@/features/account/client";
import { useOrganizations } from "@/features/account/data";
import {
	cancelOperation,
	createOcr,
	operationOptions,
	overviewOptions,
	quoteOcr,
	terminal,
	uploadPdf,
	useSpending,
} from "@/features/capabilities/data";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";

export function CloudCapabilities({ user }: { user: string }) {
	const { t } = useTranslation("account"),
		organizations = useOrganizations();
	const [org, setOrg] = useState<string | null>(null);
	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-sm font-medium">{t("capabilities.title")}</h3>
				<Select
					value={org ?? "personal"}
					onValueChange={(value) => setOrg(value === "personal" ? null : value)}
				>
					<SelectTrigger
						className="w-40"
						aria-label={t("capabilities.account")}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="personal">
							{t("capabilities.personal")}
						</SelectItem>
						{organizations.data?.map((o) => (
							<SelectItem key={o.id} value={o.id}>
								{o.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<CapabilityAccount key={`${user}:${org}`} user={user} org={org} />
		</section>
	);
}
type Pending = { fileId: string; key: string; quoteId: string; id?: string };
function CapabilityAccount({
	user,
	org,
}: {
	user: string;
	org: string | null;
}) {
	const { t } = useTranslation("account"),
		query = useQuery(overviewOptions(user, org)),
		save = useSpending(user, org);
	const storageKey = `agentero:ocr:${user}:${org ?? "personal"}`;
	const [pending, setPending] = useState<Pending | null>(() => {
		try {
			return JSON.parse(localStorage.getItem(storageKey) ?? "null");
		} catch {
			return null;
		}
	});
	const [file, setFile] = useState<File | null>(null),
		[quote, setQuote] = useState<Awaited<ReturnType<typeof quoteOcr>> | null>(
			null,
		),
		[busy, setBusy] = useState(false);
	const operation = useQuery(operationOptions(user, org, pending?.id ?? null));
	useEffect(() => {
		if (pending) localStorage.setItem(storageKey, JSON.stringify(pending));
		else localStorage.removeItem(storageKey);
	}, [storageKey, pending]);
	const updatePending = (value: Pending) => {
		localStorage.setItem(storageKey, JSON.stringify(value));
		setPending(value);
	};
	const run = async (task: () => Promise<void>) => {
		setBusy(true);
		try {
			await task();
		} catch (error) {
			notifyError(error instanceof Error ? error.message : t("errors.generic"));
		} finally {
			setBusy(false);
		}
	};
	const finished = operation.data && terminal(operation.data);
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-end gap-2">
				<Label
					htmlFor="cloud-overage"
					className="text-xs text-muted-foreground"
				>
					{t("capabilities.overage")}
				</Label>
				<Switch
					id="cloud-overage"
					disabled={!query.data?.canManage || save.isPending}
					checked={query.data?.spending.allowCreditOverage ?? false}
					onCheckedChange={(allowCreditOverage) => {
						if (query.data)
							save.mutate(
								{ ...query.data.spending, allowCreditOverage },
								{ onError: (error) => notifyError(error.message) },
							);
					}}
				/>
				<Popover>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							aria-label={t("capabilities.help")}
						>
							<CircleHelp className="size-3.5" />
						</Button>
					</PopoverTrigger>
					<PopoverContent className="text-xs">
						{t("capabilities.description")}
					</PopoverContent>
				</Popover>
			</div>
			<dl className="grid grid-cols-3 divide-x">
				{query.data?.capabilities.map((row) => (
					<div key={row.capability} className="px-3 first:pl-0">
						<dt className="text-xs text-muted-foreground">
							{t(`capabilities.${row.capability}`)}
						</dt>
						<dd className="mt-1 text-xl font-medium tabular-nums">
							{row.remaining.toLocaleString()}
						</dd>
					</div>
				))}
			</dl>
			{query.isError && (
				<Button
					variant="outline"
					size="sm"
					onClick={() => void query.refetch()}
				>
					{t("refresh")}
				</Button>
			)}
			<Button
				variant="outline"
				size="sm"
				onClick={() =>
					void openExternalUrl(
						`${accountWebOrigin}${org ? `/orgs/${org}/credits` : "/credits"}`,
					)
				}
			>
				{t("capabilities.manage")}
			</Button>
			<div className="space-y-2 border-t pt-3">
				<h4 className="text-sm font-medium">{t("capabilities.ocr")}</h4>
				<p className="text-xs text-muted-foreground">
					{t("capabilities.ocrHint")}
				</p>
				<input
					type="file"
					accept="application/pdf,.pdf"
					aria-label={t("capabilities.pdf")}
					disabled={busy || (!!pending && !finished)}
					onChange={(event) => {
						setFile(event.target.files?.[0] ?? null);
						setQuote(null);
						setPending(null);
					}}
					className="block w-full text-sm"
				/>
				{file && !quote && !pending && (
					<Button
						size="sm"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								if (file.size > 32 * 1024 * 1024)
									throw new Error(t("capabilities.fileLimit"));
								const uploaded = await uploadPdf(org, file);
								const estimate = await quoteOcr(org, uploaded.id);
								setQuote(estimate);
								updatePending({
									fileId: uploaded.id,
									key: crypto.randomUUID(),
									quoteId: estimate.id,
								});
							})
						}
					>
						{t("capabilities.estimate")}
					</Button>
				)}
				{quote && (
					<p className="text-sm">
						{t("capabilities.quote", {
							pages: quote.quantity,
							free: quote.free_quantity,
							credit: quote.credit_units / 1000,
						})}
					</p>
				)}
				{pending && !pending.id && (
					<div className="flex gap-2">
						<Button
							size="sm"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const result = await createOcr(
										org,
										pending.fileId,
										pending.quoteId,
										pending.key,
									);
									updatePending({ ...pending, id: result.operation_id });
								})
							}
						>
							{t("capabilities.start")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const estimate = await quoteOcr(org, pending.fileId);
									setQuote(estimate);
									updatePending({ ...pending, quoteId: estimate.id });
								})
							}
						>
							{t("capabilities.estimate")}
						</Button>
					</div>
				)}
				{pending?.id && (
					<div className="flex items-center gap-2">
						<p className="text-xs">
							{t(`capabilities.status.${operation.data?.status ?? "running"}`, {
								defaultValue: operation.data?.status ?? "",
							})}
						</p>
						{!finished && (
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() =>
									void run(async () => {
										await cancelOperation(org, pending.id as string);
										await operation.refetch();
									})
								}
							>
								{t("common.cancel")}
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							onClick={() => void operation.refetch()}
						>
							{t("refresh")}
						</Button>
					</div>
				)}
				{operation.data?.result?.pages && (
					<Textarea
						readOnly
						aria-label={t("capabilities.result")}
						value={operation.data.result.pages
							.map(
								(p) =>
									`<!-- Page ${p.page_number}: ${p.status} -->\n${p.markdown}`,
							)
							.join("\n\n")}
						className="min-h-48 font-mono text-xs"
					/>
				)}
				{finished && (
					<p className="text-xs text-muted-foreground">
						{t("capabilities.charged", {
							credit: operation.data.usage.charged_credit_units / 1000,
						})}
					</p>
				)}
				{finished && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setPending(null);
							setQuote(null);
							setFile(null);
						}}
					>
						{t("capabilities.newDocument")}
					</Button>
				)}
			</div>
		</div>
	);
}
