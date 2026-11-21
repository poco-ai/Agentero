import { MathRules } from "@platejs/math";
import { EquationPlugin, InlineEquationPlugin } from "@platejs/math/react";
import {
	EquationElement,
	InlineEquationElement,
} from "@/components/editor/nodes/block/equation-node";
import { inlineMathInputRule } from "@/lib/markdown/inline-math-input-rule";

export const EquationKit = [
	InlineEquationPlugin.configure({
		inputRules: [inlineMathInputRule],
		node: { component: InlineEquationElement },
	}),
	EquationPlugin.configure({
		inputRules: [MathRules.markdown({ on: "break", variant: "$$" })],
		node: { component: EquationElement },
	}),
];
