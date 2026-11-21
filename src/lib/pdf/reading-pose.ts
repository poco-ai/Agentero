export type PdfReadingPose = {
	zoom: number;
	top: number;
	left: number;
	width: number;
	height: number;
	scrollWidth: number;
	scrollHeight: number;
};

/** A resize or zoom must finish before restoring pixel coordinates from the old layout. */
export function readingPoseReady(
	pose: PdfReadingPose,
	viewport: {
		clientWidth: number;
		clientHeight: number;
		scrollWidth: number;
		scrollHeight: number;
	},
	zoom: number,
): boolean {
	return (
		Math.abs(pose.zoom - zoom) < 0.001 &&
		Math.abs(pose.width - viewport.clientWidth) <= 2 &&
		Math.abs(pose.height - viewport.clientHeight) <= 2 &&
		Math.abs(pose.scrollWidth - viewport.scrollWidth) <= 2 &&
		Math.abs(pose.scrollHeight - viewport.scrollHeight) <= 2
	);
}
