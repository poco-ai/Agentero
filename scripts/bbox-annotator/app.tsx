import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Toaster, toast } from "sonner";
import i18n from "./i18n";
import {
	type Annotation,
	type AnnotationObject,
	annotationSchema,
	type Bbox,
	derivedObjects,
	initialAnnotation,
	problems,
	type Region,
	readAnnotation,
	type Task,
} from "./model";
import "./style.css";

const task: Task = JSON.parse(
	document.getElementById("task-data")?.textContent ?? "{}",
);
const storageKey = `bbox-lab:${task.id}`;
const colors = {
	body: "#2563eb",
	panel: "#059669",
	caption: "#d97706",
	blocker: "#dc2626",
};
type Mode = "select" | Region["role"];
type Gesture = {
	start: { x: number; y: number };
	original?: Region;
	corner?: number;
	bbox: Bbox;
};
function load() {
	try {
		const value = localStorage.getItem(storageKey);
		return value
			? readAnnotation(JSON.parse(value), task)
			: initialAnnotation(task);
	} catch {
		return initialAnnotation(task);
	}
}
function App() {
	const { t } = useTranslation();
	const [data, setData] = useState<Annotation>(load);
	const [past, setPast] = useState<Annotation[]>([]),
		[future, setFuture] = useState<Annotation[]>([]);
	const [page, setPage] = useState(task.pages[0].pageIndex),
		[objectId, setObjectId] = useState(data.objects[0]?.id ?? "");
	const [regionId, setRegionId] = useState(""),
		[mode, setMode] = useState<Mode>("select");
	const [zoom, setZoom] = useState(100),
		[all, setAll] = useState(true),
		[crop, setCrop] = useState(Boolean(task.example));
	const [lesson, setLesson] = useState<
		"all" | "body" | "panel" | "caption" | "crop"
	>("all");
	const [showRules, setShowRules] = useState(
			!data.acknowledged && !task.example,
		),
		[storageOk, setStorageOk] = useState(true);
	const [reference, setReference] = useState<Annotation | null>(null),
		[gesture, setGesture] = useState<Gesture | null>(null);
	const svg = useRef<SVGSVGElement>(null);
	const currentPage = task.pages.find((p) => p.pageIndex === page)!;
	const selected = data.objects.find((o) => o.id === objectId);
	const selectedRegion = selected?.regions.find((r) => r.id === regionId);
	const errors = problems(data, task);
	const commit = (next: Annotation, invalidate = true) => {
		setPast((p) => [...p.slice(-49), data]);
		setFuture([]);
		setData({
			...next,
			stage: invalidate ? "draft" : next.stage,
			reviewer: invalidate ? "" : next.reviewer,
			updatedAt: new Date().toISOString(),
		});
	};
	const editObject = (change: Partial<AnnotationObject>) =>
		commit({
			...data,
			objects: data.objects.map((o) =>
				o.id === objectId ? { ...o, ...change } : o,
			),
		});
	const updateRegion = (bbox: Bbox) => {
		if (!selected || !selectedRegion) return;
		if (
			!annotationSchema.shape.objects.element.shape.regions.element.shape.bbox.safeParse(
				bbox,
			).success
		) {
			toast.error(t("invalidGeometry"));
			return;
		}
		editObject({
			regions: selected.regions.map((r) =>
				r.id === regionId ? { ...r, bbox } : r,
			),
		});
	};
	const undo = () => {
		if (!past.length) return;
		setFuture((f) => [data, ...f]);
		setData(past[past.length - 1]);
		setPast(past.slice(0, -1));
		setGesture(null);
	};
	const redo = () => {
		if (!future.length) return;
		setPast((p) => [...p, data]);
		setData(future[0]);
		setFuture(future.slice(1));
		setGesture(null);
	};
	useEffect(() => {
		try {
			localStorage.setItem(storageKey, JSON.stringify(data));
			setStorageOk(true);
		} catch {
			setStorageOk(false);
		}
	}, [data]);
	useEffect(() => {
		const beforeUnload = (e: BeforeUnloadEvent) => {
			if (data.objects.length || data.annotator) e.preventDefault();
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, [data]);
	useEffect(() => {
		const keydown = (e: KeyboardEvent) => {
			if (
				(e.target as HTMLElement).closest(
					"input,textarea,select,[contenteditable]",
				)
			)
				return;
			if (e.key === "Escape") {
				setGesture(null);
				setMode("select");
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				e.shiftKey ? redo() : undo();
			}
			if (
				selectedRegion &&
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
			) {
				e.preventDefault();
				const b = selectedRegion.bbox,
					delta = e.shiftKey ? 0.01 : 0.001;
				updateRegion({
					...b,
					x: Math.max(
						0,
						Math.min(
							1 - b.w,
							b.x +
								(e.key === "ArrowLeft"
									? -delta
									: e.key === "ArrowRight"
										? delta
										: 0),
						),
					),
					y: Math.max(
						0,
						Math.min(
							1 - b.h,
							b.y +
								(e.key === "ArrowUp"
									? -delta
									: e.key === "ArrowDown"
										? delta
										: 0),
						),
					),
				});
			}
		};
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	});
	const point = (e: React.PointerEvent) => {
		const rect = svg.current!.getBoundingClientRect();
		return {
			x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
			y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
		};
	};
	const start = (
		e: React.PointerEvent,
		original?: Region,
		owner?: string,
		corner?: number,
	) => {
		if (e.button !== 0 || (mode !== "select" && !selected)) return;
		e.preventDefault();
		e.stopPropagation();
		svg.current!.setPointerCapture(e.pointerId);
		const p = point(e);
		if (mode === "select") {
			if (!original) {
				setRegionId("");
				return;
			}
			setRegionId(original.id);
			setObjectId(owner ?? objectId);
			setGesture({ start: p, original, corner, bbox: original.bbox });
		} else setGesture({ start: p, bbox: { ...p, w: 0, h: 0 } });
	};
	const move = (e: React.PointerEvent) => {
		if (!gesture) return;
		const p = point(e),
			{ start: a, original, corner } = gesture;
		let bbox: Bbox;
		if (original && corner === undefined) {
			const b = original.bbox;
			bbox = {
				...b,
				x: Math.max(0, Math.min(1 - b.w, b.x + p.x - a.x)),
				y: Math.max(0, Math.min(1 - b.h, b.y + p.y - a.y)),
			};
		} else {
			const b = original?.bbox;
			const anchor = b
				? {
						x: corner === 0 || corner === 3 ? b.x + b.w : b.x,
						y: corner === 0 || corner === 1 ? b.y + b.h : b.y,
					}
				: a;
			bbox = {
				x: Math.min(anchor.x, p.x),
				y: Math.min(anchor.y, p.y),
				w: Math.abs(anchor.x - p.x),
				h: Math.abs(anchor.y - p.y),
			};
		}
		setGesture({ ...gesture, bbox });
	};
	const finish = () => {
		if (!gesture || !selected) {
			setGesture(null);
			return;
		}
		if (gesture.bbox.w >= 0.002 && gesture.bbox.h >= 0.002) {
			if (gesture.original)
				editObject({
					regions: selected.regions.map((r) =>
						r.id === gesture.original!.id ? { ...r, bbox: gesture.bbox } : r,
					),
				});
			else if (mode !== "select") {
				const region: Region = {
					id: crypto.randomUUID(),
					pageIndex: page,
					role: mode,
					bbox: gesture.bbox,
				};
				editObject({ regions: [...selected.regions, region] });
				setRegionId(region.id);
			}
		}
		setGesture(null);
	};
	const exportFile = (stage: Annotation["stage"]) => {
		if (stage !== "draft" && errors.length) {
			toast.error(t(errors[0].code, { page: errors[0].page }));
			return;
		}
		if (
			stage === "reviewed" &&
			(!data.reviewer.trim() ||
				data.reviewer.trim().toLowerCase() ===
					data.annotator.trim().toLowerCase() ||
				!data.reviewNote.trim())
		) {
			toast.error(t("needReviewer"));
			return;
		}
		const output = { ...data, stage, updatedAt: new Date().toISOString() };
		const payload = {
			...output,
			derivedObjects: derivedObjects(output),
			task: { ...task, pages: task.pages.map(({ image: _image, ...p }) => p) },
		};
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(payload, null, 2)], {
				type: "application/json",
			}),
		);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${task.id.slice(0, 16)}-${(data.annotator || "anonymous").replace(/[^\p{L}\p{N}_-]/gu, "_")}-${stage}-${Date.now()}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		setData(output);
		toast.success(t("saved"));
	};
	const importFile = async (file: File | undefined, compare = false) => {
		if (!file) return;
		try {
			if (file.size > 10_000_000) throw new Error("importFail");
			const incoming = readAnnotation(JSON.parse(await file.text()), task);
			if (compare) {
				setReference(incoming);
				toast.success(t("referenceMismatch"));
			} else if (window.confirm(t("confirmImport"))) {
				commit(incoming, false);
				setObjectId(incoming.objects[0]?.id ?? "");
				setGesture(null);
				toast.success(t("imported"));
			}
		} catch (e) {
			toast.error(
				t(
					e instanceof Error && e.message === "taskMismatch"
						? "taskMismatch"
						: "importFail",
				),
			);
		}
	};
	const objectName = (o: AnnotationObject) =>
		o.identifier || `${t(o.kind)} ${data.objects.indexOf(o) + 1}`;
	return (
		<>
			<Toaster richColors position="top-center" />
			<header>
				<div>
					<strong>{t("app")}</strong>
					<span>{t("offline")}</span>
				</div>
				<nav>
					<button type="button" onClick={() => setShowRules(true)}>
						{t("rules")}
					</button>
					<button
						type="button"
						onClick={() =>
							i18n.changeLanguage(i18n.language === "en" ? "zh-CN" : "en")
						}
					>
						{t("language")}
					</button>
					<label className="button">
						{t("import")}
						<input
							type="file"
							accept=".json"
							hidden
							onChange={(e) => {
								void importFile(e.target.files?.[0]);
								e.target.value = "";
							}}
						/>
					</label>
					<button type="button" onClick={() => exportFile("draft")}>
						{t("draft")}
					</button>
					<button type="button" onClick={() => exportFile("submitted")}>
						{t("submit")}
					</button>
					<button
						type="button"
						className="primary"
						onClick={() => exportFile("reviewed")}
					>
						{t("approve")}
					</button>
				</nav>
			</header>
			{task.example && (
				<section className="lesson" aria-label={t("demoTitle")}>
					<div>
						<strong>{t("demoTitle")}</strong>
						<span>{t("demoSubtitle")}</span>
					</div>
					<div className="lesson-steps">
						{(["all", "body", "panel", "caption", "crop"] as const).map(
							(step) => (
								<button
									type="button"
									key={step}
									className={lesson === step ? "active" : ""}
									onClick={() => {
										setLesson(step);
										setCrop(step === "all" || step === "crop");
									}}
								>
									{t(`step_${step}`)}
								</button>
							),
						)}
						<button
							type="button"
							onClick={() => {
								commit(initialAnnotation(task));
								setObjectId(task.example!.objects[0].id);
								setLesson("all");
								setCrop(true);
							}}
						>
							{t("restoreExample")}
						</button>
					</div>
					<p aria-live="polite">{t(`lesson_${lesson}`)}</p>
				</section>
			)}
			<div className={`workspace ${task.example ? "with-lesson" : ""}`}>
				<aside className="left">
					<div className="paper">
						<small>{task.id.slice(0, 12)}</small>
						<h1>{task.title}</h1>
						<p>
							{t("progress", {
								done: data.pages.filter((p) => p.state !== "todo").length,
								total: task.pages.length,
							})}
						</p>
					</div>
					<label>
						{t("annotator")}
						<input
							value={data.annotator}
							onChange={(e) => commit({ ...data, annotator: e.target.value })}
						/>
					</label>
					<div className="page-list">
						{task.pages.map((p) => (
							<button
								type="button"
								key={p.pageIndex}
								className={page === p.pageIndex ? "active" : ""}
								onClick={() => {
									setPage(p.pageIndex);
									setGesture(null);
								}}
							>
								{t("page", { page: p.pageIndex + 1 })}
								<small>
									{t(
										data.pages.find((r) => r.pageIndex === p.pageIndex)
											?.state ?? "todo",
									)}
								</small>
							</button>
						))}
					</div>
					<div className="section-title">
						<strong>
							{t("objects")} · {data.objects.length}
						</strong>
						<button
							type="button"
							onClick={() => {
								const id = crypto.randomUUID();
								commit({
									...data,
									objects: [
										...data.objects,
										{
											id,
											kind: "figure",
											identifier: "",
											captionStatus: "present",
											multipanel: false,
											uncertain: false,
											note: "",
											regions: [],
										},
									],
								});
								setObjectId(id);
								setRegionId("");
								setMode("body");
							}}
						>
							{t("add")}
						</button>
					</div>
					{data.objects.map((o) => (
						<button
							type="button"
							key={o.id}
							className={`object-row ${o.id === objectId ? "active" : ""}`}
							onClick={() => {
								setObjectId(o.id);
								setRegionId("");
								const body = o.regions.find((r) => r.role === "body");
								if (body) setPage(body.pageIndex);
							}}
						>
							{objectName(o)}
							<small>
								{o.regions.length} · {o.uncertain ? t("uncertain") : t(o.kind)}
							</small>
						</button>
					))}
					<label className="button">
						{t("reference")}
						<input
							type="file"
							accept=".json"
							hidden
							onChange={(e) => {
								void importFile(e.target.files?.[0], true);
								e.target.value = "";
							}}
						/>
					</label>
					{reference && (
						<>
							<p className="hint">
								{reference.annotator} · {t("referenceHint")}
							</p>
							<button type="button" onClick={() => setReference(null)}>
								{t("clearReference")}
							</button>
						</>
					)}
				</aside>
				<main>
					<div className="toolbar">
						<div className="modes">
							{(
								["select", "body", "panel", "caption", "blocker"] as Mode[]
							).map((m) => (
								<button
									type="button"
									key={m}
									disabled={m !== "select" && !selected}
									className={mode === m ? "active" : ""}
									style={{
										borderBottomColor: m === "select" ? undefined : colors[m],
									}}
									onClick={() => {
										setMode(m);
										setGesture(null);
									}}
								>
									{t(m)}
								</button>
							))}
						</div>
						<button type="button" disabled={!past.length} onClick={undo}>
							{t("undo")}
						</button>
						<button type="button" disabled={!future.length} onClick={redo}>
							{t("redo")}
						</button>
						<label className="zoom">
							{t("zoom")}
							<select
								value={zoom}
								onChange={(e) => setZoom(Number(e.target.value))}
							>
								{[75, 100, 150, 200].map((v) => (
									<option key={v} value={v}>
										{v}%
									</option>
								))}
							</select>
						</label>
					</div>
					<div className="canvas-scroll">
						<div
							className="canvas"
							style={{
								width: `${zoom}%`,
								aspectRatio: `${currentPage.width}/${currentPage.height}`,
							}}
						>
							<img
								src={currentPage.image}
								alt={t("page", { page: page + 1 })}
								draggable={false}
							/>
							<svg
								ref={svg}
								viewBox="0 0 1000 1000"
								preserveAspectRatio="none"
								role="img"
								aria-label={t("drawHint")}
								style={{ cursor: mode === "select" ? "default" : "crosshair" }}
								onPointerDown={(e) => start(e)}
								onPointerMove={move}
								onPointerUp={finish}
								onPointerCancel={() => setGesture(null)}
							>
								{reference?.objects.flatMap((o) =>
									o.regions
										.filter((r) => r.pageIndex === page)
										.map((r) => (
											<rect
												key={`ref-${r.id}`}
												x={r.bbox.x * 1000}
												y={r.bbox.y * 1000}
												width={r.bbox.w * 1000}
												height={r.bbox.h * 1000}
												fill="none"
												stroke="#a855f7"
												strokeWidth="2"
												strokeDasharray="5 3"
												pointerEvents="none"
											/>
										)),
								)}
								{data.objects
									.filter((o) => all || o.id === objectId)
									.flatMap((o) =>
										o.regions
											.filter(
												(r) =>
													r.pageIndex === page &&
													(!task.example ||
														lesson === "all" ||
														lesson === r.role),
											)
											.map((r) => {
												const b =
													gesture?.original?.id === r.id
														? gesture.bbox
														: r.bbox;
												return (
													<g key={r.id}>
														<rect
															x={b.x * 1000}
															y={b.y * 1000}
															width={b.w * 1000}
															height={b.h * 1000}
															fill={colors[r.role]}
															fillOpacity={r.id === regionId ? 0.14 : 0.035}
															stroke={colors[r.role]}
															strokeWidth={r.id === regionId ? 3 : 1.4}
															pointerEvents={mode === "select" ? "all" : "none"}
															onPointerDown={(e) => start(e, r, o.id)}
														/>
														<text
															x={b.x * 1000 + 3}
															y={Math.max(12, b.y * 1000 - 4)}
															fill={colors[r.role]}
															fontSize="11"
															pointerEvents="none"
														>
															{objectName(o)} · {t(r.role)}
														</text>
														{r.id === regionId &&
															mode === "select" &&
															[
																[b.x, b.y],
																[b.x + b.w, b.y],
																[b.x + b.w, b.y + b.h],
																[b.x, b.y + b.h],
															].map(([x, y], i) => (
																<rect
																	key={`${x}-${y}`}
																	x={x * 1000 - 5}
																	y={y * 1000 - 5}
																	width="10"
																	height="10"
																	fill="white"
																	stroke={colors[r.role]}
																	style={{
																		cursor:
																			i % 2 ? "nesw-resize" : "nwse-resize",
																	}}
																	onPointerDown={(e) => start(e, r, o.id, i)}
																/>
															))}
													</g>
												);
											}),
									)}
								{crop &&
									derivedObjects(data)
										.filter((o) => all || o.id === objectId)
										.filter((o) => o.pageIndex === page && o.cropBbox)
										.map((o) => (
											<rect
												key={`crop-${o.id}`}
												x={o.cropBbox!.x * 1000}
												y={o.cropBbox!.y * 1000}
												width={o.cropBbox!.w * 1000}
												height={o.cropBbox!.h * 1000}
												fill="none"
												stroke="#111827"
												strokeWidth="2"
												strokeDasharray="7 4"
												pointerEvents="none"
											/>
										))}
								{gesture && !gesture.original && (
									<rect
										x={gesture.bbox.x * 1000}
										y={gesture.bbox.y * 1000}
										width={gesture.bbox.w * 1000}
										height={gesture.bbox.h * 1000}
										stroke="#111"
										fill="#2563eb"
										fillOpacity="0.1"
										pointerEvents="none"
									/>
								)}
							</svg>
						</div>
					</div>
					<footer>
						<span>{t(selected ? "drawHint" : "startHint")}</span>
						<label>
							<input
								type="checkbox"
								checked={all}
								onChange={(e) => setAll(e.target.checked)}
							/>
							{t("showAll")}
						</label>
						<label>
							<input
								type="checkbox"
								checked={crop}
								onChange={(e) => setCrop(e.target.checked)}
							/>
							{t("crop")}
						</label>
					</footer>
				</main>
				<aside className="right">
					<label>
						{t("pageState")}
						<select
							value={data.pages.find((p) => p.pageIndex === page)?.state}
							onChange={(e) =>
								commit({
									...data,
									pages: data.pages.map((p) =>
										p.pageIndex === page
											? {
													...p,
													state: e.target.value as "todo" | "done" | "empty",
												}
											: p,
									),
								})
							}
						>
							{["todo", "done", "empty"].map((s) => (
								<option key={s} value={s}>
									{t(s)}
								</option>
							))}
						</select>
					</label>
					{selected ? (
						<>
							<h2>{objectName(selected)}</h2>
							<label>
								{t("identifier")}
								<input
									value={selected.identifier}
									onChange={(e) => editObject({ identifier: e.target.value })}
								/>
							</label>
							<label>
								{t("kind")}
								<select
									value={selected.kind}
									onChange={(e) =>
										editObject({
											kind: e.target.value as AnnotationObject["kind"],
										})
									}
								>
									{["figure", "table", "algorithm"].map((k) => (
										<option key={k} value={k}>
											{t(k)}
										</option>
									))}
								</select>
							</label>
							<label>
								<select
									aria-label={t("caption")}
									value={selected.captionStatus}
									onChange={(e) =>
										editObject({
											captionStatus: e.target.value as "present" | "absent",
										})
									}
								>
									<option value="present">{t("present")}</option>
									<option value="absent">{t("absent")}</option>
								</select>
							</label>
							<label className="check">
								<input
									type="checkbox"
									checked={selected.multipanel}
									onChange={(e) => editObject({ multipanel: e.target.checked })}
								/>
								{t("multipanel")}
							</label>
							<label className="check">
								<input
									type="checkbox"
									checked={selected.uncertain}
									onChange={(e) => editObject({ uncertain: e.target.checked })}
								/>
								{t("uncertain")}
							</label>
							<label>
								{t("note")}
								<textarea
									value={selected.note}
									onChange={(e) => editObject({ note: e.target.value })}
								/>
							</label>
							<h3>
								{t("regions")} · {selected.regions.length}
							</h3>
							{selected.regions.map((r, i) => (
								<button
									type="button"
									key={r.id}
									className={`region-row ${r.id === regionId ? "active" : ""}`}
									onClick={() => {
										setRegionId(r.id);
										setPage(r.pageIndex);
										setMode("select");
									}}
								>
									{t(r.role)} {i + 1}
									<small>{t("page", { page: r.pageIndex + 1 })}</small>
								</button>
							))}
							{selectedRegion && (
								<>
									<div className="coordinates">
										{(["x", "y", "w", "h"] as const).map((axis) => (
											<label key={axis}>
												{axis}
												<input
													type="number"
													step="0.001"
													min="0"
													max="1"
													value={Number(selectedRegion.bbox[axis].toFixed(4))}
													onChange={(e) =>
														updateRegion({
															...selectedRegion.bbox,
															[axis]: e.target.valueAsNumber,
														})
													}
												/>
											</label>
										))}
									</div>
									<button
										type="button"
										onClick={() => {
											editObject({
												regions: selected.regions.filter(
													(r) => r.id !== regionId,
												),
											});
											setRegionId("");
										}}
									>
										{t("deleteRegion")}
									</button>
								</>
							)}
							<button
								type="button"
								className="danger"
								onClick={() => {
									if (window.confirm(t("confirmDelete"))) {
										commit({
											...data,
											objects: data.objects.filter((o) => o.id !== objectId),
										});
										setObjectId("");
										setRegionId("");
									}
								}}
							>
								{t("remove")}
							</button>
						</>
					) : (
						<p className="hint">{t("noSelection")}</p>
					)}
					<section className="validation">
						<h3>
							{t("checks")} · {errors.length}
						</h3>
						{errors.length ? (
							Array.from(
								new Map(errors.map((e) => [JSON.stringify(e), e])).values(),
							).map((e) => (
								<button
									type="button"
									key={JSON.stringify(e)}
									onClick={() => {
										if (e.objectId) setObjectId(e.objectId);
										if (e.page) setPage(e.page - 1);
									}}
								>
									{e.objectId
										? `${objectName(data.objects.find((o) => o.id === e.objectId)!)}: `
										: ""}
									{t(e.code, { page: e.page })}
								</button>
							))
						) : (
							<p>{t("clear")}</p>
						)}
					</section>
					<label className="check">
						<input
							type="checkbox"
							checked={data.acknowledged}
							onChange={(e) =>
								commit({ ...data, acknowledged: e.target.checked })
							}
						/>
						{t("ack")}
					</label>
					<label>
						{t("reviewer")}
						<input
							value={data.reviewer}
							onChange={(e) =>
								commit(
									{ ...data, reviewer: e.target.value, stage: "draft" },
									false,
								)
							}
						/>
					</label>
					<label>
						{t("reviewNote")}
						<textarea
							value={data.reviewNote}
							onChange={(e) =>
								commit(
									{ ...data, reviewNote: e.target.value, stage: "draft" },
									false,
								)
							}
						/>
					</label>
					<p className="hint" role="status">
						{t(storageOk ? "storageOk" : "storageFail")}
					</p>
					<small>{t(data.stage)}</small>
				</aside>
			</div>
			{showRules && (
				<dialog open aria-labelledby="rules-title">
					<h2 id="rules-title">{t("rulesTitle")}</h2>
					<ol>
						{[
							"rule1",
							"rule2",
							"rule3",
							"rule4",
							"rule5",
							"rule6",
							"rule7",
							"rule8",
							"rule9",
							"rule10",
						].map((rule) => (
							<li key={rule}>{t(rule)}</li>
						))}
					</ol>
					<button
						type="button"
						className="primary"
						onClick={() => setShowRules(false)}
					>
						{t("close")}
					</button>
				</dialog>
			)}
		</>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
