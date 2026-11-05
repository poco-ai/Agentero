import { describe, expect, it } from "vitest";
import {
	appendRows,
	cellFromText,
	createResearchTable,
	editCells,
	parseResearchTable,
	pasteCells,
	replaceField,
} from "../src/lib/research-table/model";

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
		expect(() =>
			cellFromText("B", { ...field, type: "select", options: ["A"] }),
		).toThrow();
	});
	it("rejects duplicate ids and unsupported versions on read", () => {
		const table = appendRows(createResearchTable("Results"), 2);
		table.rows[1].id = table.rows[0].id;
		expect(() => parseResearchTable(JSON.stringify(table))).toThrow();
		expect(() =>
			parseResearchTable(JSON.stringify({ ...table, version: 2 })),
		).toThrow();
	});
});
