/** Ephemeral parser; callers reset it whenever keyboard ownership is lost. */
export class PdfKeySequence {
	private prefix = "";
	private expiresAt = 0;
	reset() {
		this.prefix = "";
		this.expiresAt = 0;
	}
	feed(
		key: string,
		now: number,
	): { consumed: boolean; page?: number | "last" } {
		if (now >= this.expiresAt) this.reset();
		// Shift is pressed before G; keep the page prefix and its deadline.
		if (key === "Shift") return { consumed: false };
		if (key === "Escape") {
			const consumed = !!this.prefix;
			this.reset();
			return { consumed };
		}
		if (/^\d$/.test(key)) {
			this.prefix = (this.prefix === "g" ? key : this.prefix + key).slice(0, 6);
			this.expiresAt = now + 1200;
			return { consumed: true };
		}
		if (key === "g") {
			if (this.prefix === "g") {
				this.reset();
				return { consumed: true, page: 1 };
			}
			this.prefix = "g";
			this.expiresAt = now + 700;
			return { consumed: true };
		}
		if (key === "G") {
			const page =
				this.prefix && this.prefix !== "g" ? Number(this.prefix) : "last";
			this.reset();
			return { consumed: true, page };
		}
		this.reset();
		return { consumed: false };
	}
}
