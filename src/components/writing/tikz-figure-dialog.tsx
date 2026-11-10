/**
 * Edit the nodes and edges of one TikZ picture. Statements the reader does
 * not understand stay in `rest` and are written back with the picture.
 */

import {
	type PointerEvent as ReactPointerEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { latexColorHex } from "@/lib/tex/color";
import type {
	TikzEdge,
	TikzNode,
	TikzPicture,
	TikzShape,
} from "@/lib/tex/tikz";

const WIDTH = 12;
const HEIGHT = 8;

const SHAPES: TikzShape[] = ["rectangle", "circle", "ellipse", "diamond"];

function nextId(nodes: readonly TikzNode[]): string {
	let index = nodes.length + 1;
	const used = new Set(nodes.map((node) => node.id));
	while (used.has(`n${index}`)) index += 1;
	return `n${index}`;
}

export function TikzFigureDialog({
	open,
	picture,
	onOpenChange,
	onApply,
}: {
	open: boolean;
	picture: TikzPicture;
	onOpenChange: (open: boolean) => void;
	onApply: (picture: TikzPicture) => void;
}) {
	const { t } = useTranslation("latexLanguage");
	const [draft, setDraft] = useState(picture);
	const svgRef = useRef<SVGSVGElement>(null);
	const nodes = useMemo(
		() => new Map(draft.nodes.map((node) => [node.id, node])),
		[draft.nodes],
	);

	function updateNode(id: string, patch: Partial<TikzNode>) {
		setDraft((current) => ({
			...current,
			nodes: current.nodes.map((node) =>
				node.id === id ? { ...node, ...patch } : node,
			),
		}));
	}

	function moveNode(id: string, event: ReactPointerEvent<SVGElement>) {
		const svg = svgRef.current;
		if (!svg) return;
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		const point = (clientX: number, clientY: number) => {
			const rect = svg.getBoundingClientRect();
			const x = ((clientX - rect.left) / rect.width) * WIDTH;
			const y = HEIGHT - ((clientY - rect.top) / rect.height) * HEIGHT;
			return {
				x: Math.round(Math.min(WIDTH, Math.max(0, x)) * 10) / 10,
				y: Math.round(Math.min(HEIGHT, Math.max(0, y)) * 10) / 10,
			};
		};
		const drag = (move: PointerEvent) => {
			const next = point(move.clientX, move.clientY);
			updateNode(id, next);
		};
		const end = () => {
			handle.removeEventListener("pointermove", drag);
			handle.removeEventListener("pointerup", end);
		};
		handle.addEventListener("pointermove", drag);
		handle.addEventListener("pointerup", end);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl"
				aria-describedby={undefined}
			>
				<DialogTitle>{t("figureTitle")}</DialogTitle>
				<svg
					ref={svgRef}
					viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
					className="h-64 w-full rounded-md border border-border bg-muted/30"
					role="img"
					aria-label={t("figureTitle")}
				>
					<title>{t("figureTitle")}</title>
					{draft.edges.map((edge) => {
						const from = nodes.get(edge.source);
						const to = nodes.get(edge.target);
						if (!from || !to) return null;
						return (
							<line
								key={edge.id}
								x1={from.x}
								y1={HEIGHT - from.y}
								x2={to.x}
								y2={HEIGHT - to.y}
								stroke="currentColor"
								strokeWidth={0.04}
								markerEnd={edge.arrow ? "url(#tikz-arrow)" : undefined}
							/>
						);
					})}
					<defs>
						<marker
							id="tikz-arrow"
							viewBox="0 0 10 10"
							refX="8"
							refY="5"
							markerWidth="4"
							markerHeight="4"
							orient="auto-start-reverse"
						>
							<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
						</marker>
					</defs>
					{draft.nodes.map((node) => (
						<g
							key={node.id}
							transform={`translate(${node.x} ${HEIGHT - node.y})`}
							onPointerDown={(event) => moveNode(node.id, event)}
							className="cursor-grab"
						>
							<NodeShape node={node} />
							<text
								y={0.12}
								textAnchor="middle"
								fontSize={0.32}
								fill="currentColor"
								className="pointer-events-none"
							>
								{node.label || node.id}
							</text>
						</g>
					))}
				</svg>
				<div className="flex max-h-40 flex-col gap-2 overflow-auto">
					{draft.nodes.map((node) => (
						<div key={node.id} className="flex items-center gap-2">
							<span className="w-8 shrink-0 font-mono text-xs">{node.id}</span>
							<input
								aria-label={t("nodeLabel")}
								value={node.label}
								onChange={(event) =>
									updateNode(node.id, { label: event.target.value })
								}
								className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-xs"
							/>
							<select
								aria-label={t("nodeShape")}
								value={node.shape}
								onChange={(event) =>
									updateNode(node.id, {
										shape: event.target.value as TikzShape,
									})
								}
								className="h-7 rounded-md border border-border bg-transparent px-1 text-xs"
							>
								{SHAPES.map((shape) => (
									<option key={shape} value={shape}>
										{t(`shape.${shape}`)}
									</option>
								))}
							</select>
							<input
								aria-label={t("nodeColor")}
								value={node.fill ?? ""}
								placeholder={t("nodeColor")}
								onChange={(event) =>
									updateNode(node.id, {
										fill: event.target.value.trim() || undefined,
									})
								}
								className="h-7 w-24 rounded-md border border-border bg-transparent px-2 text-xs"
							/>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={() =>
									setDraft((current) => ({
										...current,
										nodes: current.nodes.filter((item) => item.id !== node.id),
										edges: current.edges.filter(
											(edge) =>
												edge.source !== node.id && edge.target !== node.id,
										),
									}))
								}
							>
								{t("deleteNode")}
							</Button>
						</div>
					))}
				</div>
				<div className="flex items-center justify-between gap-2">
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() =>
								setDraft((current) => ({
									...current,
									nodes: [
										...current.nodes,
										{
											id: nextId(current.nodes),
											x: 1,
											y: 1,
											label: "",
											shape: "rectangle",
										},
									],
								}))
							}
						>
							{t("addNode")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() =>
								setDraft((current) => {
									const [sourceNode, targetNode] = current.nodes;
									if (!sourceNode || !targetNode) return current;
									const edge: TikzEdge = {
										id: `e${current.edges.length + 1}`,
										source: sourceNode.id,
										target: targetNode.id,
										arrow: true,
									};
									return { ...current, edges: [...current.edges, edge] };
								})
							}
						>
							{t("addEdge")}
						</Button>
					</div>
					<Button type="button" size="sm" onClick={() => onApply(draft)}>
						{t("applyFigure")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function NodeShape({ node }: { node: TikzNode }) {
	const fill = node.fill
		? (latexColorHex(node.fill) ?? "transparent")
		: "transparent";
	const common = {
		fill,
		stroke: "currentColor",
		strokeWidth: 0.04,
	};
	if (node.shape === "circle") return <circle r={0.45} {...common} />;
	if (node.shape === "ellipse")
		return <ellipse rx={0.7} ry={0.4} {...common} />;
	if (node.shape === "diamond")
		return <polygon points="0,-0.5 0.7,0 0,0.5 -0.7,0" {...common} />;
	return (
		<rect x={-0.8} y={-0.35} width={1.6} height={0.7} rx={0.08} {...common} />
	);
}
