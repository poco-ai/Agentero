import { describe, expect, it } from "vitest";
import { texTokenClass } from "@/lib/tex/highlight";

describe("tex source highlight roles", () => {
	it("splits commands that the grammar paints as one keyword", () => {
		expect(texTokenClass("SectionCtrlSeq")).toBe("cm-tex-heading");
		expect(texTokenClass("TextBoldCtrlSeq")).toBe(
			"cm-tex-format cm-tex-format-bold",
		);
		expect(texTokenClass("EmphasisCtrlSeq")).toBe(
			"cm-tex-format cm-tex-format-italic",
		);
		expect(texTokenClass("CiteCtrlSeq")).toBe("cm-tex-ref");
		expect(texTokenClass("RefStarrableCtrlSeq")).toBe("cm-tex-ref");
		expect(texTokenClass("Begin")).toBe("cm-tex-env");
		expect(texTokenClass("TikzPictureEnvName")).toBe("cm-tex-env");
		expect(texTokenClass("UsePackageCtrlSeq")).toBe("cm-tex-structure");
		expect(texTokenClass("HrefCtrlSeq")).toBe("cm-tex-link");
		expect(texTokenClass("MathChar")).toBe("cm-tex-math");
		expect(texTokenClass("IncludeGraphicsCtrlSeq")).toBe("cm-tex-cmd");
		expect(texTokenClass("Comment")).toBeNull();
	});
});
