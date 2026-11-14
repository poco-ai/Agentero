import type { TFunction } from "i18next";
import type { ConnectorStatus } from "@/lib/core/bindings";

/** Localize lifecycle failures while keeping OS diagnostics in Host logs. */
export function connectorStatusError(
	status: ConnectorStatus,
	t: TFunction<"settings">,
): string | null {
	if (!status.lastError) return null;
	const options = { port: status.port };
	switch (status.lastErrorCode) {
		case "portInUse":
			return t("general.connector.portInUse", options);
		case "serverStopped":
			return t("general.connector.serverStopped", options);
		case "invalidPort":
			return t("general.connector.invalidPort");
		default:
			return t("general.connector.bindFailed", options);
	}
}
