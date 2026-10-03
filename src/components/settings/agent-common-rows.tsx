import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/lib/core/tauri";
import type {
	AgentPermissionMode,
	AiResponseLanguage,
	AppSettings,
} from "@/lib/settings";
import { GITHUB_MIRROR_PRESETS } from "@/lib/settings/defaults";
import { SettingsRow } from "./settings-layout";

type Patch = (p: Partial<AppSettings>) => void;

/** Shared network proxy / mirror URL input + enable switch. */
export function NetworkProxyRow({
	htmlFor,
	label,
	description,
	proxyUrl,
	proxyEnabled,
	onProxyUrlChange,
	onCommitProxyUrl,
	onToggleProxy,
	placeholder = "http://127.0.0.1:7890",
}: {
	htmlFor: string;
	label: string;
	description?: string;
	proxyUrl: string;
	proxyEnabled: boolean;
	onProxyUrlChange: (url: string) => void;
	onCommitProxyUrl: () => void;
	onToggleProxy: (enabled: boolean) => void;
	placeholder?: string;
}) {
	return (
		<SettingsRow label={label} description={description} htmlFor={htmlFor}>
			<div className="flex items-center gap-2">
				<Input
					value={proxyUrl}
					onChange={(e) => onProxyUrlChange(e.target.value)}
					onBlur={() => onCommitProxyUrl()}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						}
					}}
					placeholder={placeholder}
					spellCheck={false}
					autoComplete="off"
					disabled={!proxyEnabled || !isTauri()}
					className="h-8 w-48 text-xs"
				/>
				<Switch
					id={htmlFor}
					checked={proxyEnabled}
					disabled={!isTauri()}
					onCheckedChange={(v) => onToggleProxy(v)}
				/>
			</div>
		</SettingsRow>
	);
}

/** GitHub mirror selector: pick from a built-in preset list, plus enable switch. */
export function GitHubMirrorRow({
	htmlFor,
	label,
	description,
	value,
	enabled,
	onValueChange,
	onToggle,
}: {
	htmlFor: string;
	label: string;
	description?: string;
	value: string;
	enabled: boolean;
	onValueChange: (url: string) => void;
	onToggle: (enabled: boolean) => void;
}) {
	return (
		<SettingsRow label={label} description={description} htmlFor={htmlFor}>
			<div className="flex items-center gap-2">
				<Select
					value={value}
					disabled={!enabled || !isTauri()}
					onValueChange={(v) => onValueChange(v)}
				>
					<SelectTrigger id={htmlFor} size="sm" className="h-8 w-48 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{GITHUB_MIRROR_PRESETS.map((url) => (
							<SelectItem key={url} value={url} className="text-xs">
								{url}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Switch
					aria-label={label}
					checked={enabled}
					disabled={!isTauri()}
					onCheckedChange={(v) => onToggle(v)}
				/>
			</div>
		</SettingsRow>
	);
}

/** Institution proxy (EZProxy/WebVPN) prefix + session cookie for paywalled
 * PDF fallback, with a connection test that fetches a known paywalled DOI. */
export function InstitutionProxyRow({
	htmlFor,
	label,
	description,
	prefix,
	cookie,
	prefixPlaceholder,
	cookiePlaceholder,
	testLabel,
	testingLabel,
	onPrefixChange,
	onCookieChange,
	onCommit,
	onTest,
	testing,
	result,
}: {
	htmlFor: string;
	label: string;
	description?: string;
	prefix: string;
	cookie: string;
	prefixPlaceholder?: string;
	cookiePlaceholder?: string;
	testLabel: string;
	testingLabel: string;
	onPrefixChange: (v: string) => void;
	onCookieChange: (v: string) => void;
	onCommit: () => void;
	onTest: () => void;
	testing: boolean;
	result?: string;
}) {
	return (
		<SettingsRow label={label} description={description} htmlFor={htmlFor}>
			<div className="flex items-center gap-2">
				<Input
					id={htmlFor}
					value={prefix}
					onChange={(e) => onPrefixChange(e.target.value)}
					onBlur={() => onCommit()}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						}
					}}
					placeholder={prefixPlaceholder}
					spellCheck={false}
					autoComplete="off"
					disabled={!isTauri()}
					className="h-8 w-56 text-xs"
				/>
				<Input
					aria-label={`${label} cookie`}
					value={cookie}
					onChange={(e) => onCookieChange(e.target.value)}
					onBlur={() => onCommit()}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						}
					}}
					placeholder={cookiePlaceholder}
					spellCheck={false}
					autoComplete="off"
					type="password"
					disabled={!isTauri()}
					className="h-8 w-32 text-xs"
				/>
				<Button
					variant="outline"
					size="sm"
					className="h-8 text-xs"
					disabled={!isTauri() || testing || !prefix.trim()}
					onClick={onTest}
				>
					{testing ? testingLabel : testLabel}
				</Button>
				{result ? (
					<span className="max-w-44 truncate text-xs text-muted-foreground">
						{result}
					</span>
				) : null}
			</div>
		</SettingsRow>
	);
}

/**
 * Shared app-level agent prefs: permission mode, auto paper-reader, response language.
 * Id suffixes keep local vs remote panes unique when both could mount.
 */
export function AgentCommonRows({
	settings,
	patch,
	idSuffix = "",
}: {
	settings: AppSettings;
	patch: Patch;
	/** e.g. "" local, "-r" remote — applied to htmlFor / control ids. */
	idSuffix?: string;
}) {
	const { t } = useTranslation("settings");
	const permId = `agent-perm${idSuffix}`;
	const autoId = `agent-auto-paper-reader${idSuffix}`;
	const langId = `agent-response-language${idSuffix}`;

	return (
		<>
			<SettingsRow label={t("agent.permission.label")} htmlFor={permId}>
				<Select
					value={settings.agentPermissionMode}
					onValueChange={(v) =>
						patch({ agentPermissionMode: v as AgentPermissionMode })
					}
				>
					<SelectTrigger id={permId} size="sm" className="min-w-[140px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="restricted">
							{t("agent.permission.restricted.label")}
						</SelectItem>
						<SelectItem value="ask">
							{t("agent.permission.ask.label")}
						</SelectItem>
						<SelectItem value="auto">
							{t("agent.permission.auto.label")}
						</SelectItem>
					</SelectContent>
				</Select>
			</SettingsRow>
			<SettingsRow label={t("agent.autoPaperReader.label")} htmlFor={autoId}>
				<Switch
					id={autoId}
					checked={settings.autoPaperReader}
					onCheckedChange={(v) => patch({ autoPaperReader: v })}
				/>
			</SettingsRow>
			<SettingsRow label={t("agent.responseLanguage.label")} htmlFor={langId}>
				<Select
					value={settings.aiResponseLanguage}
					onValueChange={(v) =>
						patch({ aiResponseLanguage: v as AiResponseLanguage })
					}
				>
					<SelectTrigger id={langId} size="sm" className="min-w-[140px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="auto">
							{t("agent.responseLanguage.auto")}
						</SelectItem>
						<SelectItem value="en">{t("agent.responseLanguage.en")}</SelectItem>
						<SelectItem value="zh-CN">
							{t("agent.responseLanguage.zhCN")}
						</SelectItem>
					</SelectContent>
				</Select>
			</SettingsRow>
		</>
	);
}
