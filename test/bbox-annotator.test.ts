import { describe, expect, it } from "vitest";
import example from "../scripts/bbox-annotator/examples/vit-page9.json";
import {
	type AnnotationObject,
	derivedObjects,
	fresh,
	initialAnnotation,
	problems,
	readAnnotation,
	type Task,
} from "../scripts/bbox-annotator/model";

const task: Task = {
	id: "task",
	pdfSha256: "sha",
	title: "test",
	source: "",
	rulesVersion: "1.0.0",
	pages: [0, 1].map((pageIndex) => ({
		pageIndex,
		width: 100,
		height: 200,
		image: "",
		imageSha256: "image",
	})),
};
function valid() {
	const data = fresh(task);
	data.annotator = "Alice";
	data.acknowledged = true;
	data.pages = [
		{ pageIndex: 0, state: "done" },
		{ pageIndex: 1, state: "done" },
	];
	data.objects = [
		{
			id: "f1",
			kind: "figure",
			identifier: "Figure 1",
			captionStatus: "present",
			multipanel: true,
			uncertain: false,
			note: "",
			regions: [
				{
					id: "body",
					role: "body",
					pageIndex: 0,
					bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.5 },
				},
				{
					id: "p1",
					role: "panel",
					pageIndex: 0,
					bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.5 },
				},
				{
					id: "p2",
					role: "panel",
					pageIndex: 0,
					bbox: { x: 0.5, y: 0.1, w: 0.3, h: 0.5 },
				},
				{
					id: "caption",
					role: "caption",
					pageIndex: 1,
					bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 },
				},
			],
		},
	];
	return data;
}
describe("offline bbox annotation contract", () => {
	it("opens the worked example with five valid boxes and one derived crop, without claiming review", () => {
		const demoTask: Task = {
			...task,
			id: "demo",
			pdfSha256: example.pdfSha256,
			pages: [{ ...task.pages[0], pageIndex: 8 }],
		};
		demoTask.example = readAnnotation(
			{ ...example, taskId: demoTask.id },
			demoTask,
		);
		const data = initialAnnotation(demoTask);
		expect(problems(data, demoTask)).toEqual([]);
		expect(data.objects).toHaveLength(1);
		expect(data.objects[0].regions).toHaveLength(5);
		expect(
			data.objects[0].regions.filter((r) => r.role === "panel"),
		).toHaveLength(3);
		expect(data.stage).toBe("draft");
		expect(data.reviewer).toBe("");
		expect(derivedObjects(data)[0].cropBbox!.h).toBeGreaterThan(
			data.objects[0].regions[0].bbox.h,
		);
	});
	it("keeps cross-page captions out of the image crop and unions same-page fragments", () => {
		const data = valid();
		expect(problems(data, task)).toEqual([]);
		expect(derivedObjects(data)[0].cropBbox).toEqual(
			data.objects[0].regions[0].bbox,
		);
		data.objects[0].regions[3] = {
			...data.objects[0].regions[3],
			pageIndex: 0,
			bbox: { x: 0.1, y: 0.65, w: 0.8, h: 0.1 },
		};
		expect(derivedObjects(data)[0].cropBbox?.h).toBeCloseTo(0.65);
	});
	it("blocks incomplete, contradictory, or ambiguous ground truth", () => {
		const data = valid();
		data.pages[0].state = "empty";
		data.objects[0].uncertain = true;
		data.objects[0].captionStatus = "absent";
		data.objects[0].regions[1].bbox.x = 0.9;
		expect(problems(data, task).map((e) => e.code)).toEqual(
			expect.arrayContaining([
				"pageNotEmpty",
				"unresolved",
				"unexpectedCaption",
				"needAbsentNote",
				"panelOutside",
			]),
		);
	});
	it("rejects another PDF, page selection, unsupported rules and invalid coordinates", () => {
		const data = valid();
		expect(readAnnotation(data, task)).toEqual(data);
		expect(() =>
			readAnnotation({ ...data, pdfSha256: "other" }, task),
		).toThrow();
		expect(() =>
			readAnnotation({ ...data, pages: [data.pages[0], data.pages[0]] }, task),
		).toThrow();
		expect(() =>
			readAnnotation({ ...data, rulesVersion: "2" }, task),
		).toThrow();
		data.objects[0].regions[0].bbox.w = 1;
		expect(() => readAnnotation(data, task)).toThrow();
	});
	it("detects missing panels, bodies, captions and duplicate identifiers", () => {
		const data = valid();
		data.objects[0].regions = [];
		data.objects.push({ ...data.objects[0], id: "f2" } as AnnotationObject);
		expect(problems(data, task).map((e) => e.code)).toEqual(
			expect.arrayContaining([
				"needPanels",
				"needBody",
				"needCaption",
				"duplicateNumber",
			]),
		);
	});
});
