import { useNativeFullscreen } from "@/hooks/use-native-fullscreen";
import { cn } from "@/lib/core/utils";

/** Strip that clears the macOS traffic lights (x=14, three ~14px buttons + gaps → ends ~68px). */
const TRAFFIC_LIGHT_STRIP = "w-[92px]";
/** Collapsed strip once native fullscreen hides the lights (~same gutter as Windows/Linux). */
const FULLSCREEN_STRIP = "w-2";

/**
 * macOS title-bar leading strip: reserves room for the native traffic lights
 * plus a gap so controls never hug them. Native fullscreen hides the lights, so
 * the strip collapses instead of stranding the row's first control ~92px in.
 *
 * Only render on macOS desktop — other platforms keep native decorations.
 */
export function TrafficLightSpacer() {
	const fullscreen = useNativeFullscreen();

	return (
		<div
			className={cn(
				"shrink-0 self-stretch",
				fullscreen ? FULLSCREEN_STRIP : TRAFFIC_LIGHT_STRIP,
			)}
			data-tauri-drag-region
		/>
	);
}
