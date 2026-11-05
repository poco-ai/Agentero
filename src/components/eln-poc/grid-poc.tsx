import DataEditor, {
	CompactSelection,
	type DataEditorRef,
	type GridCell,
	GridCellKind,
	type GridSelection,
	type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import {
	createPlatePlugin,
	Plate,
	PlateElement,
	type PlateElementProps,
	usePlateEditor,
} from "platejs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { Editor, EditorContainer } from "@/components/editor/editor-surface";
import { MarkdownEditorKit } from "@/components/editor/plugins/markdown-editor-kit";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";

type Patch = {
	key: string;
	before: string | undefined;
	after: string | undefined;
};

function GridBlock(props: PlateElementProps) {
	const { t } = useTranslation("editor");
	const values = useRef(new Map<string, string>());
	const undo = useRef<Patch[][]>([]);
	const redo = useRef<Patch[][]>([]);
	const reportEpoch = useRef(0);
	const [version, setVersion] = useState(0);
	const [rows, setRows] = useState(10000);
	const [report, setReport] = useState("");
	const [compositions, setCompositions] = useState(0);
	const grid = useRef<DataEditorRef>(null);
	const [selection, setSelection] = useState<GridSelection>({
		columns: CompactSelection.empty(),
		rows: CompactSelection.empty(),
	});
	const sampling = useRef(0);
	useEffect(() => () => cancelAnimationFrame(sampling.current), []);
	const sampleFrames = () => {
		cancelAnimationFrame(sampling.current);
		const frames: number[] = [];
		const start = performance.now();
		let previous = start;
		const frame = (now: number) => {
			frames.push(now - previous);
			previous = now;
			if (now - start < 5000) sampling.current = requestAnimationFrame(frame);
			else {
				frames.sort((a, b) => a - b);
				setReport(
					JSON.stringify({
						frameSamples: frames.length,
						p95FrameMs: +frames[Math.floor(frames.length * 0.95)].toFixed(2),
						maxFrameMs: +frames[frames.length - 1].toFixed(2),
					}),
				);
			}
		};
		sampling.current = requestAnimationFrame(frame);
	};
	const columns = Array.from({ length: 30 }, (_, i) => ({
		id: String(i),
		title: `C${i + 1}`,
		width: 130,
	}));
	const refresh = useCallback(() => setVersion((v) => v + 1), []);
	const apply = useCallback(
		(patches: Patch[], forward: boolean) => {
			for (const patch of patches) {
				const value = forward ? patch.after : patch.before;
				if (value === undefined) values.current.delete(patch.key);
				else values.current.set(patch.key, value);
			}
			refresh();
		},
		[refresh],
	);
	const commit = useCallback(
		(patches: Patch[], started: number) => {
			const changed = patches.filter((p) => p.before !== p.after);
			if (!changed.length) return;
			apply(changed, true);
			undo.current.push(changed);
			if (undo.current.length > 50) undo.current.shift();
			redo.current = [];
			const applyMs = performance.now() - started;
			const epoch = ++reportEpoch.current;
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					if (epoch !== reportEpoch.current) return;
					setReport(
						JSON.stringify({
							cells: changed.length,
							applyMs: +applyMs.toFixed(2),
							twoFramesMs: +(performance.now() - started).toFixed(2),
							lastValue: changed.at(-1)?.after,
						}),
					);
				}),
			);
		},
		[apply],
	);
	const history = useCallback(
		(forward: boolean) => {
			const from = forward ? redo.current : undo.current;
			const patch = from.pop();
			if (!patch) return;
			++reportEpoch.current;
			apply(patch, forward);
			(forward ? undo.current : redo.current).push(patch);
			setReport(
				JSON.stringify({
					operation: forward ? "redo" : "undo",
					cells: patch.length,
				}),
			);
		},
		[apply],
	);
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (
				!(event.target instanceof Element) ||
				!event.target.closest("[data-eln-grid], #portal")
			)
				return;
			// The overlay input owns native text undo until editing finishes.
			if (
				event.target.closest("input, textarea") ||
				(event.target instanceof HTMLElement && event.target.isContentEditable)
			)
				return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
				event.preventDefault();
				event.stopPropagation();
				history(event.shiftKey);
			}
		};
		window.addEventListener("keydown", listener, true);
		return () => window.removeEventListener("keydown", listener, true);
	}, [history]);
	useEffect(() => {
		const listener = () => setCompositions((n) => n + 1);
		document.addEventListener("compositionend", listener);
		return () => document.removeEventListener("compositionend", listener);
	}, []);
	// Glide uses callback identity to invalidate visible cells after sparse edits.
	// biome-ignore lint/correctness/useExhaustiveDependencies: version invalidates the grid's cached rendering.
	const getCellContent = useCallback(
		([col, row]: Item): GridCell => ({
			kind: GridCellKind.Text,
			data: values.current.get(`${col}:${row}`) ?? `R${row + 1}C${col + 1}`,
			displayData:
				values.current.get(`${col}:${row}`) ?? `R${row + 1}C${col + 1}`,
			allowOverlay: true,
		}),
		[version],
	);
	const paste = (target: Item, matrix: readonly (readonly string[])[]) => {
		const started = performance.now();
		const patches: Patch[] = [];
		matrix.forEach((line, y) => {
			line.forEach((after, x) => {
				const col = target[0] + x,
					row = target[1] + y;
				if (col >= 30 || row >= rows) return;
				const key = `${col}:${row}`;
				patches.push({ key, before: values.current.get(key), after });
			});
		});
		commit(patches, started);
		return false;
	};
	return (
		<PlateElement {...props}>
			{/* Grid owns input events; Plate owns the surrounding document. */}
			<fieldset
				contentEditable={false}
				data-eln-grid=""
				className="my-4 rounded border bg-background p-3"
				onKeyDown={(e) => e.stopPropagation()}
				onCopy={(e) => e.stopPropagation()}
				onPaste={(e) => e.stopPropagation()}
				onCut={(e) => e.stopPropagation()}
			>
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<Button
						variant="outline"
						onClick={() => {
							setSelection({
								columns: CompactSelection.empty(),
								rows: CompactSelection.empty(),
								current: {
									cell: [0, 0],
									range: { x: 0, y: 0, width: 1, height: 1 },
									rangeStack: [],
								},
							});
							grid.current?.scrollTo(0, 0);
							grid.current?.focus();
						}}
					>
						{t("elnPoc.focus")}
					</Button>
					<Button variant="outline" onClick={sampleFrames}>
						{t("elnPoc.frames")}
					</Button>
					{[10000, 100000].map((count) => (
						<Button
							key={count}
							variant="outline"
							onClick={() => setRows(count)}
						>
							{count.toLocaleString()} × 30
						</Button>
					))}
					<Button
						variant="outline"
						onClick={() => history(false)}
						disabled={!undo.current.length}
					>
						{t("elnPoc.undo")}
					</Button>
					<Button
						variant="outline"
						onClick={() => history(true)}
						disabled={!redo.current.length}
					>
						{t("elnPoc.redo")}
					</Button>
					<Button
						variant="outline"
						onClick={() =>
							paste(
								[0, 0],
								Array.from({ length: 1000 }, (_, r) =>
									Array.from({ length: 20 }, (_, c) => `样品-${r}-${c}`),
								),
							)
						}
					>
						{t("elnPoc.batch")}
					</Button>
				</div>
				<DataEditor
					ref={grid}
					gridSelection={selection}
					onGridSelectionChange={setSelection}
					width="100%"
					height={420}
					rows={rows}
					columns={columns}
					getCellContent={getCellContent}
					getCellsForSelection={true}
					onPaste={paste}
					onCellsEdited={(edits) => {
						const started = performance.now();
						commit(
							edits.flatMap(({ location: [col, row], value }) =>
								value.kind === GridCellKind.Text
									? [
											{
												key: `${col}:${row}`,
												before: values.current.get(`${col}:${row}`),
												after: value.data,
											},
										]
									: [],
							),
							started,
						);
						return true;
					}}
				/>
				<output
					className="mt-2 block break-all font-mono text-xs"
					aria-live="polite"
				>
					{rows} × 30 · compositionend: {compositions} · {report}
				</output>
			</fieldset>
			{props.children}
		</PlateElement>
	);
}

const GridPlugin = createPlatePlugin({
	key: "eln_poc_grid",
	node: { isElement: true, isVoid: true },
}).withComponent(GridBlock);

function GridPoc() {
	const { t } = useTranslation("editor");
	const editor = usePlateEditor({
		plugins: [...MarkdownEditorKit, GridPlugin],
		value: [
			{ type: "p", children: [{ text: t("elnPoc.before") }] },
			{ type: "eln_poc_grid", children: [{ text: "" }] },
			{ type: "p", children: [{ text: t("elnPoc.after") }] },
		],
	});
	return (
		<main className="h-screen bg-background p-6 text-foreground">
			<h1 className="mb-2 text-lg">{t("elnPoc.title")}</h1>
			<p className="mb-3 text-sm text-muted-foreground">{t("elnPoc.hint")}</p>
			<Plate editor={editor}>
				<EditorContainer className="h-[calc(100%-5rem)]">
					<Editor />
				</EditorContainer>
			</Plate>
			<div id="portal" />
		</main>
	);
}

export function mountGridPoc() {
	const root = document.getElementById("root");
	if (root)
		createRoot(root).render(
			<I18nextProvider i18n={i18n}>
				<GridPoc />
			</I18nextProvider>,
		);
}
