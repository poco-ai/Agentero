import { z } from "zod";

export const RULES_VERSION = "1.0.0";
export const bboxSchema = z
	.object({
		x: z.number().finite().min(0).max(1),
		y: z.number().finite().min(0).max(1),
		w: z.number().finite().positive().max(1),
		h: z.number().finite().positive().max(1),
	})
	.refine((b) => b.x + b.w <= 1.000001 && b.y + b.h <= 1.000001);
export type Bbox = z.infer<typeof bboxSchema>;
export const regionSchema = z.object({
	id: z.string().min(1),
	pageIndex: z.number().int().nonnegative(),
	role: z.enum(["body", "panel", "caption", "blocker"]),
	bbox: bboxSchema,
});
export type Region = z.infer<typeof regionSchema>;
const objectSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["figure", "table", "algorithm"]),
	identifier: z.string(),
	captionStatus: z.enum(["present", "absent"]),
	multipanel: z.boolean(),
	uncertain: z.boolean(),
	note: z.string(),
	regions: z.array(regionSchema),
});
export type AnnotationObject = z.infer<typeof objectSchema>;
export type Task = {
	id: string;
	pdfSha256: string;
	title: string;
	source: string;
	rulesVersion: string;
	example?: Annotation;
	pages: {
		pageIndex: number;
		width: number;
		height: number;
		image: string;
		imageSha256: string;
	}[];
};
export function initialAnnotation(task: Task): Annotation {
	return task.example ? readAnnotation(task.example, task) : fresh(task);
}
export const annotationSchema = z.object({
	schemaVersion: z.literal(1),
	rulesVersion: z.literal(RULES_VERSION),
	taskId: z.string(),
	pdfSha256: z.string(),
	annotator: z.string(),
	reviewer: z.string(),
	acknowledged: z.boolean(),
	stage: z.enum(["draft", "submitted", "reviewed"]),
	updatedAt: z.string(),
	reviewNote: z.string(),
	pages: z.array(
		z.object({
			pageIndex: z.number().int().nonnegative(),
			state: z.enum(["todo", "done", "empty"]),
		}),
	),
	objects: z.array(objectSchema),
});
export type Annotation = z.infer<typeof annotationSchema>;
export function fresh(task: Task): Annotation {
	return {
		schemaVersion: 1,
		rulesVersion: RULES_VERSION,
		taskId: task.id,
		pdfSha256: task.pdfSha256,
		annotator: "",
		reviewer: "",
		acknowledged: false,
		stage: "draft",
		updatedAt: new Date().toISOString(),
		reviewNote: "",
		pages: task.pages.map((p) => ({ pageIndex: p.pageIndex, state: "todo" })),
		objects: [],
	};
}
export function union(boxes: Bbox[]): Bbox | null {
	if (!boxes.length) return null;
	const x = Math.min(...boxes.map((b) => b.x)),
		y = Math.min(...boxes.map((b) => b.y));
	return {
		x,
		y,
		w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
		h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
	};
}
export function contains(a: Bbox, b: Bbox) {
	return (
		a.x <= b.x + 0.002 &&
		a.y <= b.y + 0.002 &&
		a.x + a.w >= b.x + b.w - 0.002 &&
		a.y + a.h >= b.y + b.h - 0.002
	);
}
export type Problem = { code: string; objectId?: string; page?: number };
export function problems(data: Annotation, task: Task): Problem[] {
	const errors: Problem[] = [];
	if (!data.annotator.trim()) errors.push({ code: "needAnnotator" });
	if (!data.acknowledged) errors.push({ code: "needRules" });
	const seen = new Set<string>();
	const identifiers = new Set<string>();
	const add = (code: string, objectId: string) =>
		errors.push({ code, objectId });
	for (const o of data.objects) {
		if (seen.has(o.id)) add("duplicateId", o.id);
		seen.add(o.id);
		if (o.identifier.trim()) {
			const key = `${o.kind}:${o.identifier.trim().toLowerCase()}`;
			if (identifiers.has(key)) add("duplicateNumber", o.id);
			identifiers.add(key);
		}
		const body = o.regions.filter((r) => r.role === "body");
		const panels = o.regions.filter((r) => r.role === "panel");
		const captions = o.regions.filter((r) => r.role === "caption");
		if (body.length !== 1) add("needBody", o.id);
		if (o.captionStatus === "present" && !captions.length)
			add("needCaption", o.id);
		if (o.captionStatus === "absent" && captions.length)
			add("unexpectedCaption", o.id);
		if (o.captionStatus === "absent" && !o.note.trim())
			add("needAbsentNote", o.id);
		if (o.multipanel && panels.length < 2) add("needPanels", o.id);
		if (o.uncertain) add("unresolved", o.id);
		for (const r of o.regions) {
			if (seen.has(r.id)) add("duplicateId", o.id);
			seen.add(r.id);
			if (!task.pages.some((p) => p.pageIndex === r.pageIndex))
				add("unknownPage", o.id);
			if (
				r.role === "panel" &&
				body.length === 1 &&
				(r.pageIndex !== body[0].pageIndex || !contains(body[0].bbox, r.bbox))
			)
				add("panelOutside", o.id);
		}
	}
	for (const page of task.pages) {
		const records = data.pages.filter((p) => p.pageIndex === page.pageIndex);
		if (records.length !== 1 || records[0].state === "todo")
			errors.push({ code: "pageTodo", page: page.pageIndex + 1 });
		if (
			records[0]?.state === "empty" &&
			data.objects.some((o) =>
				o.regions.some(
					(r) => r.pageIndex === page.pageIndex && r.role !== "blocker",
				),
			)
		)
			errors.push({ code: "pageNotEmpty", page: page.pageIndex + 1 });
	}
	if (data.pages.length !== task.pages.length)
		errors.push({ code: "unknownPage" });
	return errors;
}
export function readAnnotation(value: unknown, task: Task): Annotation {
	const data = annotationSchema.parse(value);
	if (data.taskId !== task.id || data.pdfSha256 !== task.pdfSha256)
		throw new Error("taskMismatch");
	if (
		data.pages.length !== task.pages.length ||
		data.pages.some(
			(p) => !task.pages.some((t) => t.pageIndex === p.pageIndex),
		) ||
		new Set(data.pages.map((p) => p.pageIndex)).size !== task.pages.length
	)
		throw new Error("taskMismatch");
	if (
		data.objects.some((o) =>
			o.regions.some(
				(r) => !task.pages.some((p) => p.pageIndex === r.pageIndex),
			),
		)
	)
		throw new Error("taskMismatch");
	return data;
}
export function derivedObjects(data: Annotation) {
	return data.objects.map((o) => {
		const body = o.regions.find((r) => r.role === "body");
		return {
			...o,
			pageIndex: body?.pageIndex,
			bodyBbox: body?.bbox,
			cropBbox: body
				? union([
						body.bbox,
						...o.regions
							.filter(
								(r) => r.role === "caption" && r.pageIndex === body.pageIndex,
							)
							.map((r) => r.bbox),
					])
				: null,
			captionFragments: o.regions
				.filter((r) => r.role === "caption")
				.map((r) => ({ pageIndex: r.pageIndex, bbox: r.bbox })),
		};
	});
}
