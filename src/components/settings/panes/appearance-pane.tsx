import { Check, LoaderCircle } from "lucide-react";
import { useTheme } from "next-themes";
import { memo, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FontFamilyPicker } from "@/components/settings/font-family-picker";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useThemePreviews } from "@/hooks/use-theme-previews";
import { cn } from "@/lib/core/utils";
import type {
	AppSettings,
	LocalePreference,
	ThemePreference,
} from "@/lib/settings";
import {
	EDITOR_LINE_HEIGHT_MAX,
	EDITOR_LINE_HEIGHT_MIN,
	EDITOR_LINE_HEIGHT_STEP,
	MARKDOWN_MAX_WIDTH_PRESETS,
	WIKI_EMBED_FONT_SIZE_MAX,
	WIKI_EMBED_FONT_SIZE_MIN,
} from "@/lib/settings";
import { applyUiTheme } from "@/lib/ui/theme";

export type AppearancePaneProps = {
	theme: ThemePreference;
	uiTheme: string;
	locale: LocalePreference;
	uiScale: number;
	editorFontSize: number;
	interfaceFontFamily: string;
	textFontFamily: string;
	monoFontFamily: string;
	editorLineHeight: number;
	showEditorToolbar: boolean;
	wikiEmbedFontSize: number;
	markdownMaxWidth: number;
	patch: (p: Partial<AppSettings>) => void;
};

function AppearancePaneInner({
	theme,
	uiTheme,
	locale,
	uiScale,
	editorFontSize,
	interfaceFontFamily,
	textFontFamily,
	monoFontFamily,
	editorLineHeight,
	showEditorToolbar,
	wikiEmbedFontSize,
	markdownMaxWidth,
	patch,
}: AppearancePaneProps) {
	const { t } = useTranslation("settings");
	const { resolvedTheme, setTheme } = useTheme();
	const fontId = useId();
	const interfaceFontId = useId();
	const textFontId = useId();
	const monoFontId = useId();
	const lineHeightId = useId();
	const wikiEmbedFontId = useId();
	const markdownWidthId = useId();
	const uiScaleId = useId();

	const [fontSize, setFontSize] = useState(editorFontSize);
	useEffect(() => {
		setFontSize(editorFontSize);
	}, [editorFontSize]);

	useEffect(() => {
		if (fontSize === editorFontSize) return;
		const id = setTimeout(() => {
			patch({ editorFontSize: fontSize });
		}, 150);
		return () => clearTimeout(id);
	}, [fontSize, editorFontSize, patch]);

	const [embedFontSize, setEmbedFontSize] = useState(wikiEmbedFontSize);
	useEffect(() => {
		setEmbedFontSize(wikiEmbedFontSize);
	}, [wikiEmbedFontSize]);

	useEffect(() => {
		if (embedFontSize === wikiEmbedFontSize) return;
		const id = setTimeout(() => {
			patch({ wikiEmbedFontSize: embedFontSize });
		}, 150);
		return () => clearTimeout(id);
	}, [embedFontSize, wikiEmbedFontSize, patch]);

	const [lineHeight, setLineHeight] = useState(editorLineHeight);
	useEffect(() => {
		setLineHeight(editorLineHeight);
	}, [editorLineHeight]);

	useEffect(() => {
		if (lineHeight === editorLineHeight) return;
		const id = setTimeout(() => {
			patch({ editorLineHeight: lineHeight });
		}, 150);
		return () => clearTimeout(id);
	}, [lineHeight, editorLineHeight, patch]);

	const [scale, setScale] = useState(uiScale);
	useEffect(() => {
		setScale(uiScale);
	}, [uiScale]);

	useEffect(() => {
		if (scale === uiScale) return;
		const id = setTimeout(() => {
			patch({ uiScale: scale });
		}, 150);
		return () => clearTimeout(id);
	}, [scale, uiScale, patch]);

	const setThemePref = (next: ThemePreference) => {
		patch({ theme: next });
		setTheme(next);
	};

	const isDark = resolvedTheme === "dark";
	const { previewThemes, hasPreviewData } = useThemePreviews(
		isDark,
		t("appearance.uiTheme.default"),
	);

	return (
		<>
			<PageTitle title={t("appearance.title")} />
			<SettingsGroup>
				<SettingsRow label={t("appearance.themeLabel")}>
					<Select
						value={theme}
						onValueChange={(v) => setThemePref(v as ThemePreference)}
					>
						<SelectTrigger size="sm" className="min-w-[120px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="system">
								{t("appearance.theme.system")}
							</SelectItem>
							<SelectItem value="light">
								{t("appearance.theme.light")}
							</SelectItem>
							<SelectItem value="dark">{t("appearance.theme.dark")}</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<div className="border-b border-border/50 px-3.5 py-3.5">
					<div className="mb-2.5 flex items-center justify-between gap-3">
						<span className="font-normal text-sm text-foreground">
							{t("appearance.uiThemeLabel")}
						</span>
						<span className="truncate text-muted-foreground text-xs">
							{previewThemes.find((item) => item.name === uiTheme)?.title ??
								uiTheme}
						</span>
					</div>
					<div className="agentero-scroll grid max-h-[15rem] grid-cols-2 auto-rows-[7.25rem] gap-2 overflow-y-auto overscroll-y-contain pr-1 sm:grid-cols-3">
						{previewThemes.map((item) => {
							const colors = isDark ? item.dark : item.light;
							const selected = item.name === uiTheme;
							return (
								<button
									key={item.name}
									type="button"
									aria-label={t("appearance.uiTheme.select", {
										name: item.title,
									})}
									aria-pressed={selected}
									onClick={() => {
										patch({ uiTheme: item.name });
										void applyUiTheme(item.name);
									}}
									className={cn(
										"group h-[7.25rem] min-w-0 rounded-lg border p-1 text-left outline-none",
										"transition-[border-color,box-shadow,transform,background-color] duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)]",
										"hover:border-primary/55 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
										"active:scale-[0.98]",
										selected
											? "border-primary/80 bg-primary/5 ring-1 ring-primary/35"
											: "border-border/70",
									)}
								>
									<div
										className="overflow-hidden rounded-md border border-black/10 p-1.5 dark:border-white/10"
										style={{ backgroundColor: colors.background }}
									>
										<div className="mb-1 flex items-center gap-1">
											<span
												className="h-1.5 w-1/3 rounded-full"
												style={{ backgroundColor: colors.primary }}
											/>
											<span
												className="h-1.5 flex-1 rounded-full opacity-60"
												style={{ backgroundColor: colors.foreground }}
											/>
										</div>
										<div
											className="rounded border p-1.5"
											style={{
												backgroundColor: colors.card,
												borderColor: colors.border,
											}}
										>
											<div
												className="mb-1 h-1 w-2/3 rounded-full bg-current opacity-50"
												style={{ color: colors.foreground }}
											/>
											<div className="flex gap-1">
												<span
													className="h-2.5 flex-1 rounded-sm"
													style={{ backgroundColor: colors.secondary }}
												/>
												<span
													className="h-2.5 w-1/3 rounded-sm"
													style={{ backgroundColor: colors.accent }}
												/>
											</div>
										</div>
									</div>
									<div className="flex min-w-0 items-center gap-1.5 px-1 py-1">
										<span className="truncate font-medium text-xs">
											{item.title}
										</span>
										{selected ? (
											<Check
												className="ml-auto size-3.5 shrink-0 text-primary"
												aria-hidden
											/>
										) : null}
									</div>
								</button>
							);
						})}
					</div>
					{!hasPreviewData ? (
						<LoaderCircle className="mx-auto mt-2 size-3.5 animate-spin text-muted-foreground" />
					) : null}
				</div>
				<SettingsRow label={t("appearance.languageLabel")}>
					<Select
						value={locale}
						onValueChange={(v) => patch({ locale: v as LocalePreference })}
					>
						<SelectTrigger size="sm" className="min-w-[120px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="system">
								{t("appearance.language.system")}
							</SelectItem>
							<SelectItem value="en">{t("appearance.language.en")}</SelectItem>
							<SelectItem value="zh-CN">
								{t("appearance.language.zhCN")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("appearance.uiScale.label")} htmlFor={uiScaleId}>
					<div className="flex items-center gap-2">
						<input
							id={uiScaleId}
							type="range"
							min={80}
							max={150}
							step={1}
							value={Math.round(scale * 100)}
							onChange={(e) => setScale(Number(e.target.value) / 100)}
							aria-valuemin={80}
							aria-valuemax={150}
							aria-valuenow={Math.round(scale * 100)}
							aria-valuetext={t("appearance.uiScale.value", {
								percent: Math.round(scale * 100),
							})}
							className="w-28 accent-primary"
						/>
						<span className="w-12 text-right text-muted-foreground text-xs tabular-nums">
							{t("appearance.uiScale.value", {
								percent: Math.round(scale * 100),
							})}
						</span>
					</div>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("appearance.fonts.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow
					label={t("appearance.fonts.interface")}
					htmlFor={interfaceFontId}
				>
					<FontFamilyPicker
						id={interfaceFontId}
						fontRole="interface"
						value={interfaceFontFamily}
						onChange={(v) => patch({ interfaceFontFamily: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("appearance.fonts.text")} htmlFor={textFontId}>
					<FontFamilyPicker
						id={textFontId}
						fontRole="text"
						value={textFontFamily}
						onChange={(v) => patch({ textFontFamily: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("appearance.fonts.mono")} htmlFor={monoFontId}>
					<FontFamilyPicker
						id={monoFontId}
						fontRole="mono"
						value={monoFontFamily}
						onChange={(v) => patch({ monoFontFamily: v })}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("appearance.markdownEditor.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("appearance.fontSize.label")} htmlFor={fontId}>
					<div className="flex items-center gap-2">
						<input
							id={fontId}
							type="range"
							min={12}
							max={20}
							step={1}
							value={fontSize}
							onChange={(e) => setFontSize(Number(e.target.value))}
							aria-valuemin={12}
							aria-valuemax={20}
							aria-valuenow={fontSize}
							aria-valuetext={t("appearance.fontSize.value", {
								size: fontSize,
							})}
							className="w-28 accent-primary"
						/>
						<span className="w-12 text-right text-muted-foreground text-xs tabular-nums">
							{t("appearance.fontSize.value", { size: fontSize })}
						</span>
					</div>
				</SettingsRow>
				<SettingsRow
					label={t("appearance.lineHeight.label")}
					htmlFor={lineHeightId}
				>
					<div className="flex items-center gap-2">
						<input
							id={lineHeightId}
							type="range"
							min={EDITOR_LINE_HEIGHT_MIN}
							max={EDITOR_LINE_HEIGHT_MAX}
							step={EDITOR_LINE_HEIGHT_STEP}
							value={lineHeight}
							onChange={(e) => setLineHeight(Number(e.target.value))}
							aria-valuemin={EDITOR_LINE_HEIGHT_MIN}
							aria-valuemax={EDITOR_LINE_HEIGHT_MAX}
							aria-valuenow={lineHeight}
							aria-valuetext={t("appearance.lineHeight.value", {
								value: lineHeight.toFixed(1),
							})}
							className="w-28 accent-primary"
						/>
						<span className="w-12 text-right text-muted-foreground text-xs tabular-nums">
							{t("appearance.lineHeight.value", {
								value: lineHeight.toFixed(1),
							})}
						</span>
					</div>
				</SettingsRow>
				<SettingsRow
					label={t("appearance.wikiEmbedFontSize.label")}
					htmlFor={wikiEmbedFontId}
				>
					<div className="flex items-center gap-2">
						<input
							id={wikiEmbedFontId}
							type="range"
							min={WIKI_EMBED_FONT_SIZE_MIN}
							max={WIKI_EMBED_FONT_SIZE_MAX}
							step={1}
							value={embedFontSize}
							onChange={(e) => setEmbedFontSize(Number(e.target.value))}
							aria-valuemin={WIKI_EMBED_FONT_SIZE_MIN}
							aria-valuemax={WIKI_EMBED_FONT_SIZE_MAX}
							aria-valuenow={embedFontSize}
							aria-valuetext={t("appearance.wikiEmbedFontSize.value", {
								size: embedFontSize,
							})}
							className="w-28 accent-primary"
						/>
						<span className="w-12 text-right text-muted-foreground text-xs tabular-nums">
							{t("appearance.wikiEmbedFontSize.value", { size: embedFontSize })}
						</span>
					</div>
				</SettingsRow>
				<SettingsRow
					label={t("appearance.markdownMaxWidth.label")}
					htmlFor={markdownWidthId}
				>
					<Select
						value={String(markdownMaxWidth)}
						onValueChange={(value) =>
							patch({ markdownMaxWidth: Number(value) })
						}
					>
						<SelectTrigger
							id={markdownWidthId}
							size="sm"
							className="min-w-[120px]"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="0">
								{t("appearance.markdownMaxWidth.full")}
							</SelectItem>
							{MARKDOWN_MAX_WIDTH_PRESETS.map((width) => (
								<SelectItem key={width} value={String(width)}>
									{t("appearance.markdownMaxWidth.value", { width })}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("appearance.editorToolbar.label")}
					htmlFor="editor-toolbar"
				>
					<Switch
						id="editor-toolbar"
						checked={showEditorToolbar}
						onCheckedChange={(v) => patch({ showEditorToolbar: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}

export const AppearancePane = memo(AppearancePaneInner);
