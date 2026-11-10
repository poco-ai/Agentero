/**
 * Named colors a TikZ option can name. Unknown names stay unresolved so the
 * source is not rewritten to a guessed hex value.
 */

const NAMED: Record<string, string> = {
	black: "000000",
	white: "FFFFFF",
	red: "FF0000",
	green: "00FF00",
	blue: "0000FF",
	cyan: "00FFFF",
	magenta: "FF00FF",
	yellow: "FFFF00",
	gray: "808080",
	darkgray: "404040",
	lightgray: "BFBFBF",
	brown: "BF8040",
	lime: "BFFF00",
	olive: "808000",
	orange: "FF8000",
	pink: "FFBFBF",
	purple: "BF0040",
	teal: "008080",
	violet: "800080",
	Apricot: "FBB982",
	Aquamarine: "00B5BE",
	Bittersweet: "C04F17",
	BlueGreen: "00B3B8",
	BrickRed: "B6321C",
	BurntOrange: "F7921D",
	CadetBlue: "74729A",
	CarnationPink: "F282B4",
	Cerulean: "00A2E3",
	Dandelion: "FDBC42",
	ForestGreen: "009B55",
	Goldenrod: "FFDF42",
	Lavender: "F49EC4",
	Mahogany: "A9341F",
	Maroon: "AF3235",
	MidnightBlue: "006795",
	Mulberry: "A93C93",
	NavyBlue: "006EB8",
	OliveGreen: "3C8031",
	OrangeRed: "ED135A",
	Orchid: "AF72B0",
	Peach: "F7965A",
	PineGreen: "008B72",
	Plum: "92268F",
	RoyalBlue: "0071BC",
	RoyalPurple: "613F99",
	Salmon: "F69289",
	SeaGreen: "3FBC9D",
	Sepia: "671800",
	SkyBlue: "46C5DD",
	SpringGreen: "C6DC67",
	Tan: "DA9D76",
	Turquoise: "00B4CE",
	VioletRed: "EF58A0",
	WildStrawberry: "EE2967",
	YellowGreen: "98CC70",
	YellowOrange: "FAA21A",
};

function channel(hex: string, offset: number): number {
	return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function mix(hex: string, percent: number): string {
	const amount = Math.min(100, Math.max(0, percent)) / 100;
	const parts = [0, 2, 4].map((offset) => {
		const value = Math.round(
			channel(hex, offset) * amount + 255 * (1 - amount),
		);
		return value.toString(16).padStart(2, "0");
	});
	return parts.join("");
}

/** `#rrggbb` for a color name, including `red!40` mixed toward white. */
export function latexColorHex(name: string): string | null {
	const match = /^([A-Za-z]+)\s*(?:!\s*(\d{1,3}))?$/.exec(name.trim());
	if (!match) return null;
	const base = NAMED[match[1] ?? ""];
	if (!base) return null;
	const percent = match[2] ? Number(match[2]) : 100;
	const hex = percent === 100 ? base : mix(base, percent);
	return `#${hex}`;
}
