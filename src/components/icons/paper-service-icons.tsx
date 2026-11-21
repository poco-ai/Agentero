/** alphaXiv brand mark (shared by Paper Info and the open-with menu). */
export function AlphaXivIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
			<title>alphaXiv</title>
			<path
				d="M2.8 10.2 8 5c1.3-1.3 3.5-1.2 4.7.2l3 3.3"
				stroke="currentColor"
				strokeWidth="3.1"
				strokeLinecap="square"
				strokeLinejoin="miter"
			/>
			<path
				d="M12.2 8.4 7.7 13c-1.2 1.2-1.2 3.1 0 4.3 1.2 1.2 3.2 1.1 4.3-.1L21 8.1"
				stroke="currentColor"
				strokeWidth="3.1"
				strokeLinecap="square"
				strokeLinejoin="miter"
			/>
			<path
				d="m16.9 14.2 4.2 4.2"
				stroke="currentColor"
				strokeWidth="3.1"
				strokeLinecap="square"
			/>
		</svg>
	);
}

/** OpenReview mark (shared by Paper Info and the open-with menu). */
export function OpenReviewIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
			<title>OpenReview</title>
			<rect width="24" height="24" rx="5" fill="#8C1B13" />
			<text
				x="12"
				y="18.2"
				textAnchor="middle"
				fill="#FFFFFF"
				fontFamily="Helvetica, Arial, sans-serif"
				fontWeight="700"
				fontSize="20"
			>
				O
			</text>
		</svg>
	);
}
