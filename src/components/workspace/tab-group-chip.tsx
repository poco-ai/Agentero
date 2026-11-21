/**
 * Custom dockview tab-group chip: double-click renames inline (click still
 * toggles collapse). Right-click / long-press stay on dockview's context menu.
 */
import type { IDockviewTabGroupChipProps } from "dockview-react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import { isTagColorId, tagSwatchStyle } from "@/lib/ui/tag-colors";

const CLICK_DELAY_MS = 280;
/** Floor / ceiling for auto-sized rename input (px). */
const RENAME_INPUT_MIN_W = 24;
const RENAME_INPUT_MAX_W = 160;
/** Extra room past measured text so caret isn't flush against the edge. */
const RENAME_INPUT_PAD_W = 6;

/**
 * Accent for dockview group underline (expanded) + empty swatch.
 * Chip itself has no fill; collapsed has no extra bar under the chip.
 */
function resolveGroupAccent(color: string | undefined): string | undefined {
	if (!color) return undefined;
	if (color === "grey") return "var(--muted-foreground)";
	if (isTagColorId(color)) {
		return tagSwatchStyle(color)?.backgroundColor;
	}
	return color;
}

export function AgenteroTabGroupChip({ tabGroup }: IDockviewTabGroupChipProps) {
	const { t } = useTranslation("app");
	const [label, setLabel] = useState(tabGroup.label);
	const [collapsed, setCollapsed] = useState(tabGroup.collapsed);
	const [color, setColor] = useState(tabGroup.color);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(tabGroup.label);
	const [inputWidth, setInputWidth] = useState(RENAME_INPUT_MIN_W);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const measureRef = useRef<HTMLSpanElement | null>(null);
	const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Keep visual state in sync with dockview model (color/label/collapse).
	useEffect(() => {
		const sync = () => {
			setLabel(tabGroup.label);
			setCollapsed(tabGroup.collapsed);
			setColor(tabGroup.color);
			if (!editing) setDraft(tabGroup.label);
		};
		sync();
		const d1 = tabGroup.onDidChange(sync);
		const d2 = tabGroup.onDidCollapseChange((c) => setCollapsed(c));
		return () => {
			d1.dispose();
			d2.dispose();
		};
	}, [tabGroup, editing]);

	useEffect(() => {
		if (!editing) return;
		const el = inputRef.current;
		if (!el) return;
		el.focus();
		el.select();
	}, [editing]);

	// Grow/shrink the rename field to match typed text (chip-sized, not a wide box).
	// `draft` re-runs after mirror text updates (ref content is not a dep).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when draft changes
	useLayoutEffect(() => {
		if (!editing) return;
		const measure = measureRef.current;
		if (!measure) return;
		const next = Math.min(
			RENAME_INPUT_MAX_W,
			Math.max(RENAME_INPUT_MIN_W, measure.offsetWidth + RENAME_INPUT_PAD_W),
		);
		setInputWidth(next);
	}, [draft, editing]);

	useEffect(() => {
		return () => {
			if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current);
		};
	}, []);

	const beginEdit = useCallback(() => {
		if (clickTimerRef.current != null) {
			clearTimeout(clickTimerRef.current);
			clickTimerRef.current = null;
		}
		setDraft(tabGroup.label);
		setEditing(true);
	}, [tabGroup]);

	const commitEdit = useCallback(() => {
		const next = draft.trim();
		const fallback = t("tabs.tabGroupDefaultName");
		tabGroup.setLabel(next.length > 0 ? next : fallback);
		setEditing(false);
	}, [draft, t, tabGroup]);

	const cancelEdit = useCallback(() => {
		setDraft(tabGroup.label);
		setEditing(false);
	}, [tabGroup]);

	const onChipClick = useCallback(
		(e: ReactMouseEvent) => {
			if (editing) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// Defer toggle so a following dblclick can cancel it.
			if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current);
			clickTimerRef.current = setTimeout(() => {
				clickTimerRef.current = null;
				tabGroup.toggle();
			}, CLICK_DELAY_MS);
		},
		[editing, tabGroup],
	);

	const onChipDoubleClick = useCallback(
		(e: ReactMouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			beginEdit();
		},
		[beginEdit],
	);

	const onInputKeyDown = useCallback(
		(e: ReactKeyboardEvent<HTMLInputElement>) => {
			// Keep Enter/Esc from bubbling into dockview shortcuts.
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				commitEdit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancelEdit();
			}
		},
		[cancelEdit, commitEdit],
	);

	const accent = resolveGroupAccent(color);
	const emptyLabel = !label;

	const chipStyle: CSSProperties | undefined = accent
		? ({
				// No fill on the chip; accent for expanded underline / empty swatch.
				["--dv-tab-group-color" as string]: accent,
			} as CSSProperties)
		: undefined;

	return (
		// Chip may host a nested rename <input>; a native <button> cannot.
		// biome-ignore lint/a11y/useSemanticElements: drag host + nested input
		<div
			className={cn(
				"dv-tab-group-chip relative inline-flex items-center gap-0.5",
				collapsed && "dv-tab-group-chip--collapsed",
				!accent && "dv-tab-group-chip--accent-off",
			)}
			style={chipStyle}
			tabIndex={0}
			role="button"
			aria-label={
				editing
					? t("tabs.tabGroupRenameAria")
					: t("tabs.tabGroupChipAria", {
							name: label || t("tabs.tabGroupDefaultName"),
						})
			}
			aria-expanded={!collapsed}
			onClick={onChipClick}
			onDoubleClick={onChipDoubleClick}
			onKeyDown={(e) => {
				if (editing) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					tabGroup.toggle();
				} else if (e.key === "F2") {
					e.preventDefault();
					beginEdit();
				}
			}}
		>
			{/* Collapse affordance: › when folded, ▾ when open. */}
			{collapsed ? (
				<ChevronRight
					className="size-3 shrink-0 opacity-80"
					style={accent ? { color: accent } : undefined}
					aria-hidden
				/>
			) : (
				<ChevronDown
					className="size-3 shrink-0 opacity-80"
					style={accent ? { color: accent } : undefined}
					aria-hidden
				/>
			)}
			{editing ? (
				<>
					{/* Invisible mirror: same font metrics as the input, drives width. */}
					<span
						ref={measureRef}
						className="pointer-events-none invisible absolute whitespace-pre text-[length:inherit] font-[inherit]"
						aria-hidden
					>
						{draft.length > 0 ? draft : "\u00a0"}
					</span>
					<input
						ref={inputRef}
						type="text"
						className="dv-tab-group-chip-rename-input border-0 bg-transparent px-0.5 py-0 text-[length:inherit] font-[inherit] text-inherit outline-none ring-1 ring-ring rounded-sm"
						style={{ width: inputWidth }}
						value={draft}
						aria-label={t("tabs.tabGroupRenameAria")}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={onInputKeyDown}
						onBlur={() => commitEdit()}
						onClick={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
						onPointerDown={(e) => e.stopPropagation()}
					/>
				</>
			) : (
				<span
					className={cn(
						"dv-tab-group-chip-label",
						emptyLabel && "dv-tab-group-chip-label--empty",
					)}
				>
					{label}
				</span>
			)}
		</div>
	);
}
