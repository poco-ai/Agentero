import type { Theme } from "@glideapps/glide-data-grid";
import { useEffect, useState } from "react";

/** Glide's color parser accepts sRGB strings; app tokens use OKLCH. */
export function useGridTheme() {
	const [theme, setTheme] = useState<Partial<Theme>>();
	useEffect(() => {
		const root = document.documentElement;
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;
		const update = () => {
			const style = getComputedStyle(root);
			const color = (token: string, alpha = 1) => {
				ctx.clearRect(0, 0, 1, 1);
				ctx.fillStyle = style.getPropertyValue(token).trim();
				ctx.fillRect(0, 0, 1, 1);
				const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
				return `rgba(${r},${g},${b},${(a / 255) * alpha})`;
			};
			setTheme({
				bgCell: color("--background"),
				bgCellMedium: color("--muted"),
				bgHeader: color("--muted", 0.55),
				bgHeaderHovered: color("--accent"),
				bgHeaderHasFocus: color("--accent"),
				bgBubble: color("--secondary"),
				bgBubbleSelected: color("--accent"),
				textDark: color("--foreground"),
				textMedium: color("--muted-foreground"),
				textLight: color("--muted-foreground"),
				textHeader: color("--foreground"),
				textHeaderSelected: color("--foreground"),
				textBubble: color("--foreground"),
				bgIconHeader: color("--muted-foreground"),
				fgIconHeader: color("--background"),
				borderColor: color("--border", 0.65),
				horizontalBorderColor: color("--border", 0.65),
				accentColor: color("--brand"),
				accentFg: color("--primary-foreground"),
				accentLight: color("--brand", 0.12),
				fontFamily: getComputedStyle(document.body).fontFamily,
				baseFontStyle: "13px",
				headerFontStyle: "500 13px",
				editorFontSize: "13px",
			});
		};
		update();
		const observer = new MutationObserver(update);
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["class", "style"],
		});
		return () => observer.disconnect();
	}, []);
	return theme;
}
