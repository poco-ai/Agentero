import { authQueryKeys } from "@better-auth-ui/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TFunction } from "i18next";
import { LogOut, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	cancelAuth,
	onAuthError,
	onAuthenticated,
	onSignedOut,
	requestAuth,
	signOut,
} from "tauri-plugin-better-auth/client";
import { CloudCapabilities } from "@/components/settings/capabilities";
import { CloudUsageLine } from "@/components/settings/cloud-usage";
import { Button } from "@/components/ui/button";
import { accountWebOrigin } from "@/features/account/client";
import {
	accountQueryClient,
	clearAccountCache,
	useAccountSession,
	useOrganizations,
} from "@/features/account/data";
import { apiErrorMessage } from "@/features/account/errors";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@/features/account/primitives/avatar";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { PageTitle } from "../settings-layout";

function openWeb(path: string, t: TFunction<"account">) {
	void openUrl(`${accountWebOrigin}${path}`).catch((error) =>
		notifyError(apiErrorMessage(t, error)),
	);
}

function SignedInAccount() {
	const { t } = useTranslation("account");
	const session = useAccountSession();
	const organizations = useOrganizations();
	const user = session.data?.user;
	if (!user) return null;
	const initial = (user.name || user.email || "?").slice(0, 1).toUpperCase();
	const isAdmin = "role" in user && user.role === "admin";
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<Avatar size="lg">
					{user.image ? <AvatarImage src={user.image} alt="" /> : null}
					<AvatarFallback>{initial}</AvatarFallback>
				</Avatar>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">
						{user.name || user.email}
					</p>
					{user.name ? (
						<p className="truncate text-sm text-muted-foreground">
							{user.email}
						</p>
					) : null}
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0"
					onClick={() => openWeb("/account", t)}
				>
					{t("editProfile")}
				</Button>
			</div>
			<div className="space-y-2">
				<p className="text-sm font-medium">{t("cloudSync.title")}</p>
				<CloudUsageLine subject="user" namespace="account" />
			</div>
			<CloudCapabilities user={user.id} />
			<div className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm font-medium">{t("teams")}</p>
					<Button
						variant="ghost"
						size="sm"
						className="shrink-0"
						onClick={() => openWeb("/teams", t)}
					>
						{t("manageTeams")}
					</Button>
				</div>
				{organizations.isPending ? null : organizations.data?.length ? (
					<ul className="space-y-1 text-sm text-muted-foreground">
						{organizations.data.map((org) => (
							<li key={org.id} className="truncate">
								{org.name}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">{t("noTeams")}</p>
				)}
			</div>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					onClick={() =>
						void signOut().catch((error) =>
							notifyError(apiErrorMessage(t, error)),
						)
					}
				>
					<LogOut className="size-4" />
					{t("signOut")}
				</Button>
				{isAdmin ? (
					<Button variant="outline" onClick={() => openWeb("/admin/users", t)}>
						{t("administration")}
					</Button>
				) : null}
			</div>
		</div>
	);
}

function AccountContent() {
	const { t } = useTranslation("account");
	const session = useAccountSession();
	const [pending, setPending] = useState(false);
	const refresh = () => accountQueryClient.invalidateQueries();
	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		const cleanup: Array<() => void> = [];
		const register = (promise: Promise<() => void>) =>
			void promise.then((stop) => (disposed ? stop() : cleanup.push(stop)));
		register(
			onAuthenticated(() => {
				clearAccountCache();
				setPending(false);
				void accountQueryClient.invalidateQueries({
					queryKey: authQueryKeys.session,
				});
			}),
		);
		register(
			onSignedOut(() => {
				clearAccountCache();
				setPending(false);
			}),
		);
		register(
			onAuthError((error) => {
				setPending(false);
				if (!error.code.includes("CANCEL"))
					notifyError(apiErrorMessage(t, error));
			}),
		);
		return () => {
			disposed = true;
			cleanup.forEach((stop) => {
				stop();
			});
		};
	}, [t]);
	const start = async () => {
		setPending(true);
		try {
			const result = await requestAuth();
			if (!result.opened) await openUrl(result.url);
		} catch (error) {
			setPending(false);
			notifyError(apiErrorMessage(t, error));
		}
	};
	return (
		<>
			<PageTitle
				title={t("title")}
				actions={
					<Button
						size="icon"
						variant="ghost"
						aria-label={t("refresh")}
						onClick={() => void refresh()}
					>
						<RefreshCw className="size-4" />
					</Button>
				}
			/>
			{!session.data ? (
				<div className="flex items-center gap-2">
					<Button
						disabled={pending || session.isPending}
						onClick={() => void start()}
					>
						{t(pending ? "waiting" : "signIn")}
					</Button>
					{pending && (
						<Button
							variant="outline"
							onClick={() =>
								void cancelAuth()
									.then(() => setPending(false))
									.catch((error) => notifyError(apiErrorMessage(t, error)))
							}
						>
							{t("common.cancel")}
						</Button>
					)}
				</div>
			) : (
				<SignedInAccount />
			)}
		</>
	);
}

export function AccountPane() {
	return (
		<QueryClientProvider client={accountQueryClient}>
			<AccountContent />
		</QueryClientProvider>
	);
}
