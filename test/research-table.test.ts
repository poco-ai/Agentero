import { describe, expect, it } from "vitest";
import {
	acceptsSchemaPath,
	appendRows,
	applySchemaFields,
	archiveRows,
	cellFromText,
	checkSchema,
	createResearchTable,
	duplicateRows,
	editCells,
	fieldChangeNeedsMigration,
	parseResearchTable,
	pasteCells,
	previewRows,
	removeRows,
	replaceField,
	researchTableStem,
	resizeColumn,
	restoreRows,
	TABLE_SUFFIX,
} from "../src/lib/research-table/model";
import {
	applyViewPaste,
	cycleSort,
	researchTableCsv,
	sourceRowIndex,
	visibleRowIndexes,
} from "../src/lib/research-table/view";

it("derives a table display name from TABLE_SUFFIX.length", () => {
	const filename = `results${TABLE_SUFFIX}`;
	expect(researchTableStem(filename)).toBe("results");
	expect(researchTableStem(filename)).toBe(
		filename.slice(0, -TABLE_SUFFIX.length),
	);
	expect(researchTableStem("notes.json")).toBe("notes.json");
});

describe("research table contracts", () => {
	it("retains stable row and field identities across edits and round trips", () => {
		const table = appendRows(createResearchTable("Measurements"), 2);
		const next = pasteCells(table, 0, 0, [["中文样品"], ["other"]]);
		expect(parseResearchTable(JSON.stringify(next))).toEqual(next);
		expect(next.rows[0].id).toBe(table.rows[0].id);
		expect(next.fields[0].id).toBe(table.fields[0].id);
		expect(table.rows[0].values).toEqual({});
	});
	it("validates scattered edits atomically and keeps untouched rows shared", () => {
		const table = appendRows(createResearchTable("Results"), 3);
		table.fields[0].type = "number";
		const changes = [
			{ col: 0, row: 0, text: "2" },
			{ col: 0, row: 2, text: "3" },
		];
		const edited = editCells(table, changes);
		expect(edited.rows[1]).toBe(table.rows[1]);
		expect(edited.rows[0].id).toBe(table.rows[0].id);
		expect(() =>
			editCells(table, [...changes, { col: 0, row: 1, text: "NaN" }]),
		).toThrow();
		expect(
			table.rows.every((row) => Object.keys(row.values).length === 0),
		).toBe(true);
	});
	it("rejects changing units of stored measurements without a migration", () => {
		const table = createResearchTable("Results");
		table.fields[0].type = "number";
		table.fields[0].unit = "mAh";
		const measured = pasteCells(table, 0, 0, [["2.31"]]);
		expect(() =>
			replaceField(measured, { ...measured.fields[0], unit: "Ah" }),
		).toThrow();
	});
	it("rejects an entire invalid numeric paste without modifying the original", () => {
		const table = createResearchTable("Results");
		table.fields[0].type = "number";
		expect(() => pasteCells(table, 0, 0, [["2.31"], ["invalid"]])).toThrow();
		expect(table.rows).toHaveLength(0);
	});
	it("extends rows for rectangular Excel paste and distinguishes zero from missing", () => {
		const table = createResearchTable("Results");
		table.fields[0].type = "number";
		const next = pasteCells(table, 0, 0, [["0"], [""], ["1e-3"]]);
		expect(next.rows.map((row) => row.values[table.fields[0].id])).toEqual([
			0,
			null,
			0.001,
		]);
	});
	it("rejects extra columns instead of silently discarding data", () => {
		expect(() =>
			pasteCells(createResearchTable("Results"), 0, 0, [["a", "b"]]),
		).toThrow();
	});
	it("prevents schema changes that invalidate existing observations", () => {
		const table = pasteCells(createResearchTable("Results"), 0, 0, [
			["sample"],
		]);
		expect(() =>
			replaceField(table, { ...table.fields[0], type: "number" }),
		).toThrow();
	});
	it("validates dates, booleans, enums and non-finite numbers", () => {
		const field = createResearchTable("Results").fields[0];
		expect(() =>
			cellFromText("2026-02-30", { ...field, type: "date" }),
		).toThrow();
		expect(cellFromText("2026-02-28", { ...field, type: "date" })).toBe(
			"2026-02-28",
		);
		expect(cellFromText("FALSE", { ...field, type: "boolean" })).toBe(false);
		expect(() =>
			cellFromText("Infinity", { ...field, type: "number" }),
		).toThrow();
		expect(() => cellFromText("0x10", { ...field, type: "number" })).toThrow();
		expect(() =>
			cellFromText(" 0X10 ", { ...field, type: "number" }),
		).toThrow();
		expect(() => cellFromText("0b10", { ...field, type: "number" })).toThrow();
		expect(cellFromText("1e-3", { ...field, type: "number" })).toBe(0.001);
		expect(cellFromText("  ", { ...field, type: "number" })).toBeNull();
		expect(() =>
			cellFromText("B", { ...field, type: "select", options: ["A"] }),
		).toThrow();
	});
	it("rewrites stored cells when a select option is renamed", () => {
		const table = createResearchTable("Results");
		table.fields[0] = {
			...table.fields[0],
			type: "select",
			options: ["low", "high"],
		};
		const filled = pasteCells(table, 0, 0, [["low"], ["high"], ["low"]]);
		const ids = filled.rows.map((row) => row.id);
		const next = replaceField(
			filled,
			{ ...filled.fields[0], options: ["small", "high"] },
			{ low: "small" },
		);
		expect(next.rows.map((row) => row.values[filled.fields[0].id])).toEqual([
			"small",
			"high",
			"small",
		]);
		expect(next.rows.map((row) => row.id)).toEqual(ids);
		expect(next.rows.map((row) => row.registryId)).toEqual(
			filled.rows.map((row) => row.registryId),
		);
		expect(next.rows.map((row) => row.updatedAt)).toEqual(
			filled.rows.map((row) => row.updatedAt),
		);
		expect(filled.rows.map((row) => row.values[filled.fields[0].id])).toEqual([
			"low",
			"high",
			"low",
		]);
	});
	it("refuses to remove a select option that rows still use", () => {
		const table = createResearchTable("Results");
		table.fields[0] = {
			...table.fields[0],
			type: "select",
			options: ["low", "high"],
		};
		const filled = pasteCells(table, 0, 0, [["low"], ["high"], ["low"]]);
		expect(() =>
			replaceField(filled, { ...filled.fields[0], options: ["high"] }),
		).toThrow("option in use: 2");
		expect(filled.rows).toHaveLength(3);
	});
	it("treats a whitespace-only unit edit as the same measurement", () => {
		const table = createResearchTable("Results");
		table.fields[0].type = "number";
		table.fields[0].unit = "mAh";
		const measured = pasteCells(table, 0, 0, [["2.31"]]);
		expect(
			fieldChangeNeedsMigration(measured, {
				...measured.fields[0],
				unit: "mAh ",
			}),
		).toBe(false);
		expect(
			replaceField(measured, { ...measured.fields[0], unit: "mAh " }).fields[0]
				.unit,
		).toBe("mAh");
		expect(
			fieldChangeNeedsMigration(measured, {
				...measured.fields[0],
				unit: "Ah",
			}),
		).toBe(true);
	});
	it("sorts and filters without rewriting stored row order", () => {
		const table = createResearchTable("Results");
		table.fields[0].type = "number";
		const filled = pasteCells(table, 0, 0, [["2"], [""], ["10"]]);
		const ids = filled.rows.map((row) => row.id);
		const fieldId = filled.fields[0].id;
		expect(
			visibleRowIndexes(filled, {
				query: "",
				sort: { fieldId, direction: "asc" },
			}),
		).toEqual([0, 2, 1]);
		expect(
			visibleRowIndexes(filled, {
				query: "",
				sort: { fieldId, direction: "desc" },
			}),
		).toEqual([2, 0, 1]);
		expect(
			visibleRowIndexes(filled, {
				query: "10",
				sort: { fieldId, direction: "asc" },
			}),
		).toEqual([2]);
		expect(filled.rows.map((row) => row.id)).toEqual(ids);
		expect(cycleSort(null, fieldId)).toEqual({
			fieldId,
			direction: "asc",
		});
		expect(cycleSort({ fieldId, direction: "asc" }, fieldId)?.direction).toBe(
			"desc",
		);
		expect(cycleSort({ fieldId, direction: "desc" }, fieldId)).toBeNull();
	});
	it("appends from the trailing view row and keeps a sorted paste on the source rows", () => {
		const table = createResearchTable("Results");
		expect(sourceRowIndex(0, [2, 0], 5)).toBe(2);
		expect(sourceRowIndex(2, [2, 0], 5)).toBe(5);
		const stored = appendRows(table, 2);
		const next = applyViewPaste(stored, 0, 0, [["b"], ["a"]], [1, 0]);
		expect(next.rows.map((row) => row.values[stored.fields[0].id])).toEqual([
			"a",
			"b",
		]);
		expect(next.rows.map((row) => row.id)).toEqual(
			stored.rows.map((row) => row.id),
		);
		table.fields[0].type = "number";
		expect(() => applyViewPaste(table, 0, 0, [["0x10"]], [])).toThrow();
		expect(table.rows).toHaveLength(0);
		const appended = applyViewPaste(table, 0, 0, [["4"], ["5"]], []);
		expect(appended.rows.map((row) => row.values[table.fields[0].id])).toEqual([
			4, 5,
		]);
	});
	it("previews the newest rows", () => {
		expect(previewRows([1, 2, 3], 2)).toEqual([2, 3]);
		expect(previewRows([1, 2], 20)).toEqual([1, 2]);
		expect(previewRows([], 20)).toEqual([]);
	});
	it("rejects duplicate ids and unsupported versions on read", () => {
		const table = appendRows(createResearchTable("Results"), 2);
		table.rows[1].id = table.rows[0].id;
		expect(() => parseResearchTable(JSON.stringify(table))).toThrow();
		expect(() =>
			parseResearchTable(JSON.stringify({ ...table, version: 2 })),
		).toThrow();
	});
	it("parses a table without registry metadata and does not write those keys back", () => {
		const legacy = {
			format: "agentero-table",
			version: 1,
			id: "table-1",
			name: "Legacy",
			kind: "result",
			revision: 3,
			fields: [
				{ id: "name", name: "Name", type: "text", unit: "", options: [] },
			],
			rows: [{ id: "row-1", values: { name: "kept" } }],
		};
		const parsed = parseResearchTable(JSON.stringify(legacy));
		expect(JSON.parse(JSON.stringify(parsed))).toEqual(legacy);
		const edited = appendRows(parsed, 1);
		expect(edited.rows[0]).toBe(parsed.rows[0]);
		expect(edited.idPrefix).toBe("ID");
		expect(edited.rows[1]?.registryId).toBe("ID-0001");
		expect(edited.rows[1]?.actor).toBe("human");
		const created = edited.rows[1]?.createdAt ?? "";
		expect(created).toBe(new Date(created).toISOString());
		expect(edited.rows[1]?.updatedAt).toBe(created);
	});
	it("issues registry ids and does not reuse one after archive and permanent delete", () => {
		const table = appendRows(createResearchTable("Results"), 2);
		expect(table.rows.map((row) => row.registryId)).toEqual([
			"ID-0001",
			"ID-0002",
		]);
		expect(table.nextSequence).toBe(3);
		expect(() => removeRows(table, [0])).toThrow(/archive before delete/);
		const archived = archiveRows(table, [0]);
		expect(archived.rows).toHaveLength(2);
		expect(archived.rows[0]?.archivedAt).toBe(
			new Date(archived.rows[0]?.archivedAt ?? "").toISOString(),
		);
		expect(archived.rows[1]).toBe(table.rows[1]);
		const removed = removeRows(archived, [0]);
		expect(removed.rows.map((row) => row.registryId)).toEqual(["ID-0002"]);
		expect(removed.nextSequence).toBe(3);
		const again = appendRows(removed, 1);
		expect(again.rows.map((row) => row.registryId)).toEqual([
			"ID-0002",
			"ID-0003",
		]);
		const restored = restoreRows(archived, [0]);
		expect(restored.rows[0]?.archivedAt).toBeUndefined();
		expect(JSON.stringify(restored.rows[0])).not.toContain("archivedAt");
		expect(restored.rows[0]?.registryId).toBe("ID-0001");
		const lowered = parseResearchTable(
			JSON.stringify({ ...table, nextSequence: 1 }),
		);
		expect(appendRows(lowered, 1).rows[2]?.registryId).toBe("ID-0003");
	});
	it("duplicates stored rows with new registry ids and no archive state", () => {
		const table = appendRows(createResearchTable("Results"), 2);
		const field = table.fields[0].id;
		const filled = pasteCells(table, 0, 0, [["alpha"], ["beta"]]);
		const archived = archiveRows(filled, [0]);
		const copy = duplicateRows(archived, [0, 1]);
		expect(copy.rows).toHaveLength(4);
		expect(copy.rows[0]).toBe(archived.rows[0]);
		expect(copy.rows[1]).toBe(archived.rows[1]);
		expect(copy.rows[0]?.registryId).toBe("ID-0001");
		expect(copy.rows[0]?.archivedAt).toBeTruthy();
		expect(copy.rows[2]?.archivedAt).toBeUndefined();
		expect(copy.rows[2]?.values[field]).toBe("alpha");
		expect(copy.rows[3]?.values[field]).toBe("beta");
		expect(copy.rows[2]?.id).not.toBe(copy.rows[0]?.id);
		expect(copy.rows[2]?.registryId).toBe("ID-0003");
		expect(copy.rows[3]?.registryId).toBe("ID-0004");
		expect(copy.rows[2]?.actor).toBe("human");
		expect(copy.rows[3]?.actor).toBe("human");
		expect(copy.nextSequence).toBe(5);
		expect(copy.rows[2]?.createdAt).toBe(copy.rows[2]?.updatedAt);
		expect(JSON.stringify(copy.rows[2])).not.toContain("archivedAt");
		expect(duplicateRows(copy, [])).toBe(copy);
	});
	it("stores a column width and omits the default", () => {
		const table = createResearchTable("Results");
		expect(resizeColumn(table, 0, 200)).toBe(table);
		const wider = resizeColumn(table, 0, 340.4);
		expect(wider.fields[0]?.width).toBe(340);
		expect(parseResearchTable(JSON.stringify(wider)).fields[0]?.width).toBe(
			340,
		);
		const unit = {
			...wider,
			fields: [{ ...wider.fields[0], type: "number" as const, unit: "mAh" }],
		};
		expect(resizeColumn(unit, 0, 220).fields[0]?.width).toBeUndefined();
		expect(JSON.stringify(resizeColumn(unit, 0, 220).fields[0])).not.toContain(
			"width",
		);
		expect(resizeColumn(unit, 0, 200).fields[0]?.width).toBe(200);
		expect(resizeColumn(table, 0, 12).fields[0]?.width).toBe(80);
		expect(resizeColumn(table, 0, 900).fields[0]?.width).toBe(480);
		const legacy = parseResearchTable(
			JSON.stringify({
				...table,
				fields: [
					{
						id: table.fields[0].id,
						name: "Name",
						type: "text",
						unit: "",
						options: [],
					},
				],
			}),
		);
		expect(legacy.fields[0]?.width).toBeUndefined();
		expect(JSON.stringify(legacy)).not.toContain("width");
		expect(() =>
			parseResearchTable(
				JSON.stringify({
					...table,
					fields: [{ ...table.fields[0], width: 40 }],
				}),
			),
		).toThrow();
	});
	it("exports active rows with registry ids and escaped quotes", () => {
		const table = appendRows(createResearchTable("Results"), 2);
		const named = {
			...table,
			fields: [{ ...table.fields[0], unit: "g" }],
		};
		const filled = pasteCells(named, 0, 0, [['say "hi"'], ["beta"]]);
		const archived = archiveRows(filled, [1]);
		expect(researchTableCsv(archived)).toBe(
			['"registryId","Name (g)"', '"ID-0001","say ""hi"""'].join("\r\n"),
		);
	});
	it("rejects a duplicate registry id", () => {
		const table = appendRows(createResearchTable("Results"), 2);
		table.rows[1].registryId = table.rows[0]?.registryId;
		expect(() => parseResearchTable(JSON.stringify(table))).toThrow(
			/duplicate registry id/,
		);
		table.rows[1].registryId = "ID-1";
		expect(() => parseResearchTable(JSON.stringify(table))).toThrow(
			/invalid registry id/,
		);
	});
	it("validates link values and vault-relative targets", () => {
		const base = createResearchTable("Results");
		base.fields[0] = { ...base.fields[0], type: "link", unit: "", options: [] };
		expect(cellFromText("ID-0001", base.fields[0])).toBe("ID-0001");
		expect(cellFromText("", base.fields[0])).toBeNull();
		expect(() => cellFromText("0x10", base.fields[0])).toThrow();
		expect(() => cellFromText("nope", base.fields[0])).toThrow();
		const dangling = pasteCells(base, 0, 0, [["MISSING-0007"]]);
		expect(dangling.rows[0]?.values[base.fields[0].id]).toBe("MISSING-0007");
		expect(() =>
			parseResearchTable(
				JSON.stringify({
					...base,
					fields: [{ ...base.fields[0], target: "../x.table.json" }],
				}),
			),
		).toThrow(/invalid table path/);
		expect(() =>
			parseResearchTable(
				JSON.stringify({
					...createResearchTable("Results"),
					schemaPath: "../x.table.json",
				}),
			),
		).toThrow(/invalid table path/);
		const linked = parseResearchTable(
			JSON.stringify({
				...base,
				fields: [{ ...base.fields[0], target: "other/schema.table.json" }],
			}),
		);
		expect(linked.fields[0]?.target).toBe("other/schema.table.json");
		expect(
			acceptsSchemaPath("other/schema.table.json", "results.table.json"),
		).toBe(true);
		expect(acceptsSchemaPath("results.table.json", "results.table.json")).toBe(
			false,
		);
		const filled = pasteCells(createResearchTable("Results"), 0, 0, [
			["sample"],
		]);
		expect(
			fieldChangeNeedsMigration(filled, { ...filled.fields[0], type: "link" }),
		).toBe(true);
		expect(() =>
			replaceField(filled, { ...filled.fields[0], type: "link" }),
		).toThrow();
	});
	it("hides archived rows until the view asks for them", () => {
		const table = createResearchTable("Results");
		table.fields[0].type = "number";
		const filled = pasteCells(table, 0, 0, [["2"], ["9"], ["10"]]);
		const archived = archiveRows(filled, [1]);
		const fieldId = filled.fields[0].id;
		expect(visibleRowIndexes(archived, { query: "", sort: null })).toEqual([
			0, 2,
		]);
		expect(
			visibleRowIndexes(archived, {
				query: "",
				sort: null,
				showArchived: true,
			}),
		).toEqual([0, 1, 2]);
		expect(visibleRowIndexes(archived, { query: "9", sort: null })).toEqual([]);
		expect(
			visibleRowIndexes(archived, {
				query: "9",
				sort: null,
				showArchived: true,
			}),
		).toEqual([1]);
		expect(
			visibleRowIndexes(archived, {
				query: "",
				sort: { fieldId, direction: "asc" },
			}),
		).toEqual([0, 2]);
		expect(archived.rows.map((row) => row.id)).toEqual(
			filled.rows.map((row) => row.id),
		);
	});
	it("checks a schema without rejecting extra fields", () => {
		const schema = parseResearchTable(
			JSON.stringify({
				...createResearchTable("Schema"),
				fields: [
					{ id: "name", name: "Name", type: "text", unit: "", options: [] },
					{ id: "mass", name: "Mass", type: "number", unit: "g", options: [] },
				],
			}),
		);
		const instance = parseResearchTable(
			JSON.stringify({
				...createResearchTable("Run"),
				fields: [
					{ id: "name", name: "Name", type: "text", unit: "", options: [] },
					{ id: "mass", name: "Mass", type: "number", unit: "g", options: [] },
					{ id: "note", name: "Note", type: "text", unit: "", options: [] },
				],
			}),
		);
		expect(checkSchema(instance, schema)).toEqual({ ok: true, problems: [] });
		const mismatch = parseResearchTable(
			JSON.stringify({
				...instance,
				fields: instance.fields.map((field) =>
					field.id === "mass" ? { ...field, type: "text", unit: "" } : field,
				),
			}),
		);
		expect(checkSchema(mismatch, schema).ok).toBe(false);
		expect(checkSchema(mismatch, schema).problems).toContainEqual({
			id: "mass",
			issue: "type",
		});
		const partial = parseResearchTable(
			JSON.stringify({
				...instance,
				fields: instance.fields.filter((field) => field.id !== "mass"),
			}),
		);
		const applied = applySchemaFields(partial, schema);
		expect(applied.fields.map((field) => field.id)).toEqual([
			"name",
			"note",
			"mass",
		]);
		expect(applied.fields.find((field) => field.id === "mass")).toMatchObject({
			name: "Mass",
			type: "number",
			unit: "g",
		});
		expect(applySchemaFields(mismatch, schema).fields).toEqual(mismatch.fields);
	});
	it("keeps appliedKeys on parse and replaceField, and accepts an agent row", () => {
		const created = createResearchTable("Results");
		expect(created.appliedKeys).toBeUndefined();
		const untouched = parseResearchTable(JSON.stringify(created));
		expect(untouched.appliedKeys).toBeUndefined();
		expect(JSON.stringify(untouched)).not.toContain("appliedKeys");
		const withKeys = parseResearchTable(
			JSON.stringify({ ...created, appliedKeys: ["batch-1"] }),
		);
		expect(withKeys.appliedKeys).toEqual(["batch-1"]);
		const renamed = replaceField(withKeys, {
			...withKeys.fields[0],
			name: "Sample",
		});
		expect(renamed.appliedKeys).toEqual(["batch-1"]);
		expect(renamed.fields[0].name).toBe("Sample");
		const agent = parseResearchTable(`{
			"format": "agentero-table",
			"version": 1,
			"id": "table-stable-id",
			"name": "Measurements",
			"kind": "result",
			"revision": 1,
			"idPrefix": "ID",
			"nextSequence": 2,
			"fields": [
				{"id":"sample","name":"Name","type":"text","unit":"","options":[]}
			],
			"rows": [{
				"id": "row-1",
				"values": {"sample": "BAT-001"},
				"registryId": "ID-0001",
				"createdAt": "2026-11-07T00:00:00.000Z",
				"updatedAt": "2026-11-07T00:00:00.000Z",
				"actor": "agent"
			}]
		}`);
		expect(agent.rows[0]).toMatchObject({
			registryId: "ID-0001",
			actor: "agent",
			createdAt: "2026-11-07T00:00:00.000Z",
			updatedAt: "2026-11-07T00:00:00.000Z",
		});
		expect(agent.appliedKeys).toBeUndefined();
		expect(JSON.stringify(agent)).not.toContain("appliedKeys");
	});
});
