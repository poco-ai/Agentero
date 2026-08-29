import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import { probeEmbedding } from "@/lib/recommend";
import type { AppSettings, EmbeddingSettings } from "@/lib/settings";
import { isTranslateApiKeyMask } from "@/lib/translate";

export function AgentEmbeddingBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	// Embedding endpoint (BYOK) — local draft, committed on blur. apiKey may be a
	// host `*` mask on load; sending it back unchanged keeps the stored secret.
	const embedding = settings.embedding;
	const [embDraft, setEmbDraft] = useState<EmbeddingSettings>(() => ({
		...embedding,
	}));
	useEffect(() => {
		setEmbDraft({ ...embedding });
	}, [embedding]);
	const commitEmbedding = useCallback(
		(next: Partial<EmbeddingSettings>) => {
			patch({ embedding: { ...settings.embedding, ...next } });
		},
		[patch, settings.embedding],
	);
	const [embProbeBusy, setEmbProbeBusy] = useState(false);
	const [embProbeStatus, setEmbProbeStatus] = useState<
		"idle" | "probing" | "ok" | "failed" | "unconfigured"
	>("idle");
	// Auto-flip the dot to "unconfigured" when the draft lacks a baseUrl/model
	// (and we're not in the middle of a probe). Otherwise keep the last status.
	useEffect(() => {
		if (embProbeBusy) return;
		if (!embDraft.baseUrl.trim() || !embDraft.model.trim()) {
			setEmbProbeStatus("unconfigured");
		} else if (embProbeStatus === "unconfigured") {
			setEmbProbeStatus("idle");
		}
	}, [embDraft.baseUrl, embDraft.model, embProbeBusy, embProbeStatus]);
	const runEmbProbe = useCallback(async () => {
		const baseUrl = embDraft.baseUrl.trim();
		const model = embDraft.model.trim();
		if (!baseUrl || !model) return;
		setEmbProbeBusy(true);
		setEmbProbeStatus("probing");
		try {
			// Skip the apiKey override when the user has not typed a new key
			// (empty or Host `*` mask) so the Host falls back to the stored secret.
			const apiKey = embDraft.apiKey.trim();
			await probeEmbedding({
				baseUrl,
				apiKey: apiKey && !isTranslateApiKeyMask(apiKey) ? apiKey : undefined,
				model,
			});
			setEmbProbeStatus("ok");
		} catch {
			setEmbProbeStatus("failed");
		} finally {
			setEmbProbeBusy(false);
		}
	}, [embDraft.apiKey, embDraft.baseUrl, embDraft.model]);

	function embProbeDotClass(status: typeof embProbeStatus): string {
		switch (status) {
			case "ok":
				return "bg-emerald-500";
			case "failed":
				return "bg-destructive";
			case "probing":
				return "bg-amber-500 animate-pulse";
			case "unconfigured":
				return "bg-muted-foreground/35";
			default:
				return "bg-muted-foreground/50";
		}
	}

	return (
		<>
			{/* Embedding endpoint (BYOK) for arxiv daily recommendation & semantic features. */}
			<div className="mb-1.5 mt-4 flex items-center justify-between gap-2">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					{t("agent.embedding.section")}
				</p>
				<div className="flex items-center gap-1.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								role="status"
								aria-label={t(
									`agent.embedding.probeStatus.${embProbeStatus}` as "agent.embedding.probeStatus.idle",
								)}
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									embProbeDotClass(embProbeStatus),
								)}
							/>
						</TooltipTrigger>
						<TooltipContent>
							{t(
								`agent.embedding.probeStatus.${embProbeStatus}` as "agent.embedding.probeStatus.idle",
							)}
						</TooltipContent>
					</Tooltip>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={
							embProbeBusy || !embDraft.baseUrl.trim() || !embDraft.model.trim()
						}
						onClick={() => void runEmbProbe()}
					>
						{embProbeBusy ? (
							<Loader2 className="size-3.5 animate-spin" aria-hidden />
						) : null}
						{embProbeBusy
							? t("agent.embedding.testing")
							: t("agent.embedding.test")}
					</Button>
				</div>
			</div>
			<SettingsGroup>
				<SettingsRow
					label={t("agent.embedding.baseUrl.label")}
					htmlFor="agent-embedding-base-url"
				>
					<Input
						id="agent-embedding-base-url"
						value={embDraft.baseUrl}
						onChange={(e) =>
							setEmbDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
						}
						onBlur={() => {
							const trimmed = embDraft.baseUrl.trim().replace(/\/+$/, "");
							if (trimmed !== settings.embedding.baseUrl) {
								commitEmbedding({ baseUrl: trimmed });
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						placeholder="https://api.openai.com/v1"
						spellCheck={false}
						autoComplete="off"
						className="h-8 w-56 font-mono text-xs placeholder:text-muted-foreground/50"
					/>
				</SettingsRow>
				<SettingsRow
					label={t("agent.embedding.apiKey.label")}
					htmlFor="agent-embedding-api-key"
				>
					<Input
						id="agent-embedding-api-key"
						type="password"
						value={embDraft.apiKey}
						onChange={(e) =>
							setEmbDraft((prev) => ({ ...prev, apiKey: e.target.value }))
						}
						onFocus={(e) => {
							// Select the mask so the next keystroke replaces it entirely.
							if (isTranslateApiKeyMask(embDraft.apiKey)) {
								e.currentTarget.select();
							}
						}}
						onBlur={() => {
							const next = embDraft.apiKey.trim();
							// Unchanged mask → send as-is so the Host keeps the stored secret.
							if (next !== settings.embedding.apiKey) {
								commitEmbedding({ apiKey: next });
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						placeholder="sk-…"
						spellCheck={false}
						autoComplete="off"
						className="h-8 w-56 font-mono text-xs placeholder:text-muted-foreground/50"
					/>
				</SettingsRow>
				<SettingsRow
					label={t("agent.embedding.model.label")}
					htmlFor="agent-embedding-model"
				>
					<Input
						id="agent-embedding-model"
						value={embDraft.model}
						onChange={(e) =>
							setEmbDraft((prev) => ({ ...prev, model: e.target.value }))
						}
						onBlur={() => {
							const trimmed = embDraft.model.trim();
							if (trimmed !== settings.embedding.model) {
								commitEmbedding({ model: trimmed });
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						placeholder="text-embedding-3-small"
						spellCheck={false}
						autoComplete="off"
						className="h-8 w-56 font-mono text-xs placeholder:text-muted-foreground/50"
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}
