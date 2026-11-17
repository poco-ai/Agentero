export interface PlatformOverrides {
	isTauri?: boolean;
	platformOS?: "macos" | "windows" | "linux" | "other";
	isMacOS?: boolean;
	isWindows?: boolean;
	isMobileApp?: boolean;
	isWebKitEngine?: boolean;
}

export function makeTauriPlatform(overrides: PlatformOverrides = {}) {
	const platformOS = overrides.platformOS ?? "other";
	return {
		isTauri: () => overrides.isTauri ?? false,
		getPlatformOS: () => platformOS,
		isMacOS: () => overrides.isMacOS ?? platformOS === "macos",
		isWindows: () => overrides.isWindows ?? platformOS === "windows",
		isMobileApp: () => overrides.isMobileApp ?? false,
		isWebKitEngine: () => overrides.isWebKitEngine ?? false,
	};
}
