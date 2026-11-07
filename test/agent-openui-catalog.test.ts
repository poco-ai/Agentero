import { describe, expect, it } from "vitest";
import { blockProps, uiBlockLibrary } from "@/lib/agent/openui/catalog";
import {
	OPENUI_COMPONENT_NAMES,
	OPENUI_COMPONENT_SIGNATURES,
} from "@/lib/agent/openui/generated/catalog";
import snapshot from "./fixtures/openui-catalog.snapshot.json";

describe("generated OpenUI catalog snapshot", () => {
	it("matches the checked-in signature snapshot", () => {
		expect(snapshot.componentCount).toBe(OPENUI_COMPONENT_NAMES.length);
		expect(snapshot.components).toHaveLength(OPENUI_COMPONENT_NAMES.length);

		for (const component of snapshot.components) {
			expect(OPENUI_COMPONENT_SIGNATURES).toHaveProperty(
				component.name,
				component.signature,
			);
			expect(uiBlockLibrary.toSpec().components[component.name]).toMatchObject({
				signature: component.signature,
				description: component.description,
			});
		}
	});

	it("keeps names, props and parser signatures in one catalog", () => {
		expect(OPENUI_COMPONENT_NAMES).toEqual(Object.keys(blockProps));
		expect(new Set(OPENUI_COMPONENT_NAMES).size).toBe(
			OPENUI_COMPONENT_NAMES.length,
		);
		expect(uiBlockLibrary.root).toBe("Stack");
	});
});
