import {
	Columns2,
	File,
	MoveHorizontal,
	MoveVertical,
	Plus,
	RotateCcw,
	Rows2,
	Square,
	Type,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-app-stores";
import {
	DEFAULT_READING_SETTINGS,
	READING_LIMITS,
	READING_THEMES,
	type ReadingSettings,
	type ReadingSplit,
	readingColors,
} from "@/lib/pdf/reading/settings";
import { loadSettings, saveSettings } from "@/lib/settings";

function ReadingSegments({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
			<span className="text-xs">{label}</span>
			<fieldset
				aria-label={label}
				className="grid min-w-0 auto-cols-fr grid-flow-col gap-px rounded-lg border bg-muted p-0.5 [&>button]:min-w-0 [&>button]:rounded-md [&>button]:border-0 [&>button]:aria-pressed:bg-background [&>button]:aria-pressed:shadow-sm"
			>
				{children}
			</fieldset>
		</div>
	);
}

function ReadingNumberInput({
	id,
	value,
	limits,
	onCommit,
}: {
	id: string;
	value: number;
	limits: { min: number; max: number; step: number };
	onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<input
			id={id}
			className="w-12 rounded border bg-transparent px-1 py-0.5 text-right text-xs tabular-nums"
			type="number"
			value={draft ?? value}
			{...limits}
			onChange={(event) => setDraft(event.currentTarget.value)}
			onBlur={(event) => {
				const next = event.currentTarget.valueAsNumber;
				if (Number.isFinite(next)) onCommit(next);
				setDraft(null);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

export type PdfReadingControls = {
	enabled: boolean;
	onEnabledChange: (enabled: boolean) => void;
	settings: ReadingSettings;
	onSettingsChange: (patch: Partial<ReadingSettings>) => void;
	available: boolean;
	pdfSplit: ReadingSplit;
	onPdfSplitChange: (split: ReadingSplit) => void;
};
export function PdfReadingPopover({
	enabled,
	onEnabledChange,
	settings,
	onSettingsChange,
	available,
	pdfSplit,
	onPdfSplitChange,
}: PdfReadingControls) {
	const { t } = useTranslation("viewer");
	const id = useId();
	const scrollStrategy = useSettings((state) => state.pdfScrollStrategy);
	const spreadMode = useSettings((state) => state.pdfSpreadMode);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					size="icon-xs"
					variant={enabled ? "secondary" : "ghost"}
					aria-label={t("pdf.reading.title")}
					title={t("pdf.reading.title")}
				>
					<Type className="size-3.5" aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] gap-5 overflow-x-hidden overflow-y-auto p-4 [&>*]:shrink-0"
				data-pdf-chrome
				aria-label={t("pdf.reading.title")}
			>
				<div className="flex items-center justify-between gap-3">
					<label htmlFor={`${id}-enabled`} className="font-medium">
						{t("pdf.reading.title")}
					</label>
					<Button
						type="button"
						size="icon-xs"
						variant="ghost"
						className="ml-auto"
						aria-label={t("pdf.reading.reset")}
						title={t("pdf.reading.reset")}
						onClick={() => onSettingsChange(DEFAULT_READING_SETTINGS)}
					>
						<RotateCcw className="size-3.5" aria-hidden />
					</Button>
					<Switch
						id={`${id}-enabled`}
						checked={enabled}
						onCheckedChange={onEnabledChange}
						disabled={!available}
					/>
				</div>
				{!available && (
					<p className="text-muted-foreground text-xs">
						{t("pdf.reading.unavailable")}
					</p>
				)}
				{!enabled && (
					<div className="space-y-3 border-t pt-4">
						<ReadingSegments label={t("pdf.reading.scroll.label")}>
							{(
								[
									{ value: "vertical", Icon: MoveVertical },
									{ value: "horizontal", Icon: MoveHorizontal },
								] as const
							).map(({ value, Icon }) => (
								<Button
									key={value}
									type="button"
									size="sm"
									variant="ghost"
									aria-pressed={scrollStrategy === value}
									aria-label={t(`pdf.reading.scroll.${value}`)}
									title={t(`pdf.reading.scroll.${value}`)}
									onClick={() =>
										saveSettings({
											...loadSettings(),
											pdfScrollStrategy: value,
										})
									}
								>
									<Icon className="size-4" aria-hidden />
								</Button>
							))}
						</ReadingSegments>
						<ReadingSegments label={t("pdf.reading.spread.label")}>
							{(["none", "odd", "even"] as const).map((value) => (
								<Button
									key={value}
									type="button"
									size="sm"
									variant="ghost"
									disabled={scrollStrategy === "paginated"}
									aria-pressed={
										(scrollStrategy === "paginated" ? "none" : spreadMode) ===
										value
									}
									aria-label={t(`pdf.reading.spread.${value}`)}
									title={t(`pdf.reading.spread.${value}`)}
									onClick={() =>
										saveSettings({ ...loadSettings(), pdfSpreadMode: value })
									}
								>
									{value === "none" ? (
										<File className="size-4" aria-hidden />
									) : (
										<span
											aria-hidden
											className="flex font-mono text-[0.625rem] leading-none [&>span]:border [&>span]:px-0.5 [&>span]:py-px"
										>
											<span>{value === "odd" ? "1" : "2"}</span>
											<span>{value === "odd" ? "2" : "3"}</span>
										</span>
									)}
								</Button>
							))}
						</ReadingSegments>
					</div>
				)}
				{enabled &&
					(
						[
							"lineHeight",
							"wordSpacing",
							"characterSpacing",
							"pageWidth",
						] as const
					).map((key) => {
						const limits = READING_LIMITS[key];
						const label = t(`pdf.reading.${key}`);
						return (
							<div
								key={key}
								className="grid grid-cols-[1fr_4.5rem] items-center gap-x-3 gap-y-2"
							>
								<label htmlFor={`${id}-${key}`} className="col-span-2 text-xs">
									{label}
								</label>
								<Slider
									value={[settings[key]]}
									min={limits.min}
									max={limits.max}
									step={limits.step}
									aria-label={label}
									onValueChange={(values) => {
										if (values[0] != null)
											onSettingsChange({ [key]: values[0] });
									}}
								/>
								<div className="flex items-center justify-end gap-0.5">
									<ReadingNumberInput
										id={`${id}-${key}`}
										value={settings[key]}
										limits={limits}
										onCommit={(value) => onSettingsChange({ [key]: value })}
									/>
									{key !== "lineHeight" && (
										<span className="text-muted-foreground text-xs">%</span>
									)}
								</div>
							</div>
						);
					})}
				<div className="border-t pt-4">
					<ReadingSegments label={t("pdf.reading.split")}>
						{(
							[
								{ value: "single", Icon: Square },
								{ value: "side-by-side", Icon: Columns2 },
								{ value: "top-bottom", Icon: Rows2 },
							] as const
						).map(({ value, Icon }) => (
							<Button
								key={value}
								type="button"
								size="sm"
								variant="ghost"
								disabled={!available}
								aria-pressed={(enabled ? settings.split : pdfSplit) === value}
								aria-label={t(
									`pdf.reading.${enabled ? "layout" : "pdfLayout"}.${value}`,
								)}
								title={t(
									`pdf.reading.${enabled ? "layout" : "pdfLayout"}.${value}`,
								)}
								onClick={() => {
									if (enabled) onSettingsChange({ split: value });
									else onPdfSplitChange(value);
								}}
							>
								<Icon className="size-4" aria-hidden />
							</Button>
						))}
					</ReadingSegments>
				</div>
				<section
					aria-labelledby={`${id}-theme`}
					className="min-w-0 space-y-3 border-t pt-4"
				>
					<div id={`${id}-theme`} className="text-xs">
						{t("pdf.reading.theme")}
					</div>
					<div className="grid w-full min-w-0 grid-cols-3 gap-2">
						{READING_THEMES.map((theme) => (
							<Button
								key={theme}
								type="button"
								variant="outline"
								className="h-9 min-w-0 p-0 text-xs aria-pressed:ring-2 aria-pressed:ring-primary"
								style={readingColors({ ...settings, theme })}
								aria-label={t(`pdf.reading.themes.${theme}`)}
								title={t(`pdf.reading.themes.${theme}`)}
								aria-pressed={settings.theme === theme}
								onClick={() => onSettingsChange({ theme })}
							>
								{theme === "custom" ? (
									<Plus className="size-4" aria-hidden />
								) : (
									t(`pdf.reading.themes.${theme}`)
								)}
							</Button>
						))}
					</div>
					{settings.theme === "custom" && (
						<div className="grid grid-cols-2 gap-3 pt-2">
							{(["foreground", "background"] as const).map((key) => (
								<label
									key={key}
									className="flex items-center justify-between gap-2 text-xs"
								>
									{t(`pdf.reading.${key}`)}
									<input
										type="color"
										value={settings[key]}
										onChange={(event) =>
											onSettingsChange({ [key]: event.currentTarget.value })
										}
										className="h-7 w-9 cursor-pointer rounded border p-0.5"
									/>
								</label>
							))}
						</div>
					)}
				</section>
			</PopoverContent>
		</Popover>
	);
}
