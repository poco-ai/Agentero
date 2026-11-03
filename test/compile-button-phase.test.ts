import { expect, it } from "vitest";
import {
	compileButtonDisplay,
	compileButtonPhase,
	compileInvolvesRoot,
	shouldFlashCompileSuccess,
} from "@/lib/writing/compile-button";

const ROOT = "C:/vault/thesis/main.tex";

it("treats the root and a child source as this compile", () => {
	expect(compileInvolvesRoot(ROOT, ROOT)).toBe(true);
	expect(compileInvolvesRoot("C:\\vault\\thesis\\chapters\\a.tex", ROOT)).toBe(
		true,
	);
	expect(compileInvolvesRoot("C:/vault/other/main.tex", ROOT)).toBe(false);
	expect(compileInvolvesRoot("C:/vault/thesis-notes/main.tex", ROOT)).toBe(
		false,
	);
	expect(compileInvolvesRoot(null, ROOT)).toBe(false);
});

it("shows the first compile as soon as this root is claimed", () => {
	expect(
		compileButtonPhase({
			compilingPath: "C:/vault/thesis/chapters/a.tex",
			rootFile: ROOT,
		}),
	).toBe("running");
});

it("does not spin a bar whose project is not compiling", () => {
	expect(
		compileButtonPhase({
			compilingPath: "C:/vault/other/main.tex",
			rootFile: ROOT,
		}),
	).toBe("idle");
	expect(
		compileButtonPhase({
			compilingPath: "C:/vault/other/main.tex",
			rootFile: ROOT,
			status: "succeeded",
		}),
	).toBe("succeeded");
});

it("stops the spinner when the build finishes, even if the path is still set", () => {
	expect(
		compileButtonPhase({
			compilingPath: ROOT,
			rootFile: ROOT,
			status: "succeeded",
		}),
	).toBe("succeeded");
	expect(
		compileButtonPhase({
			compilingPath: ROOT,
			rootFile: ROOT,
			status: "failed",
		}),
	).toBe("failed");
	expect(
		compileButtonPhase({
			compilingPath: ROOT,
			rootFile: ROOT,
			status: "cancelled",
		}),
	).toBe("idle");
});

it("keeps a running snapshot spinning until it reaches a terminal status", () => {
	expect(
		compileButtonPhase({
			compilingPath: null,
			rootFile: ROOT,
			status: "running",
		}),
	).toBe("running");
});

it("recovers the button after failure and cancel, and only flashes a real success", () => {
	expect(compileButtonDisplay("failed", false)).toBe("idle");
	expect(compileButtonDisplay("idle", false)).toBe("idle");
	expect(compileButtonDisplay("succeeded", false)).toBe("idle");
	expect(compileButtonDisplay("succeeded", true)).toBe("succeeded");
	expect(compileButtonDisplay("running", true)).toBe("running");
	expect(shouldFlashCompileSuccess("running", "succeeded")).toBe(true);
	expect(shouldFlashCompileSuccess("idle", "succeeded")).toBe(false);
	expect(shouldFlashCompileSuccess("succeeded", "succeeded")).toBe(false);
	expect(shouldFlashCompileSuccess("running", "failed")).toBe(false);
	expect(shouldFlashCompileSuccess("running", "idle")).toBe(false);
});
