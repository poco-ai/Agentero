import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/lib/core/background-tasks";
import { type SyncCloudUsage, syncCloudUsage } from "@/lib/sync/api";

export function useCloudUsage(
	subject: "user" | "organization",
	orgId?: string,
	revision = 0,
	enabled = true,
) {
	const [usage, setUsage] = useState<SyncCloudUsage | null>(null);
	useEffect(() => {
		// Refetch when the account signs in or out.
		void revision;
		if (!enabled) {
			setUsage(null);
			return;
		}
		let cancelled = false;
		void syncCloudUsage(subject, orgId)
			.then((next) => {
				if (!cancelled) setUsage(next);
			})
			.catch(() => {
				if (!cancelled) setUsage(null);
			});
		return () => {
			cancelled = true;
		};
	}, [subject, orgId, revision, enabled]);
	return usage;
}

export function CloudUsageLine({
	subject,
	orgId,
	namespace = "settings",
	revision = 0,
}: {
	subject: "user" | "organization";
	orgId?: string;
	namespace?: "settings" | "account";
	revision?: number;
}) {
	const { t } = useTranslation(namespace);
	const usage = useCloudUsage(subject, orgId, revision);
	if (!usage) return null;
	if (!usage.signedIn) {
		return (
			<p className="text-muted-foreground text-xs">
				{t("cloudSync.signInRequired")}
			</p>
		);
	}
	const limit =
		usage.limit < 0 ? t("cloudSync.unlimited") : formatBytes(usage.limit);
	return (
		<div className="space-y-1">
			<p className="text-sm">
				{t("cloudSync.usedOf", { used: formatBytes(usage.used), limit })}
			</p>
			{usage.limit === 0 ? (
				<p className="text-muted-foreground text-xs">
					{t("cloudSync.notIncluded")}
				</p>
			) : null}
		</div>
	);
}
