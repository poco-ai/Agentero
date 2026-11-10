import { Cloud, CloudDownload, CloudOff, Loader2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	getSession,
	onAuthenticated,
	onSignedOut,
	requestAuth,
} from "tauri-plugin-better-auth/client";
import { TreeRowActionButton } from "@/components/sidebar/tree-row-action-button";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { accountWebOrigin } from "@/features/account/client";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isMobileApp } from "@/lib/core/tauri";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { openWritingFile } from "@/lib/workspace/navigation";
import { flushAllTextEditors } from "@/lib/workspace/text-editor-flush";
import { type CloudProject, listCloudProjects } from "@/lib/writing/cloud/api";
import {
	downloadWritingCheckout,
	publishWritingCheckout,
} from "@/lib/writing/cloud/checkout";
import { useWritingCloudContext } from "./writing-cloud-context";

function useCloudAccount(open: boolean) {
	const [signedIn, setSignedIn] = useState<boolean | null>(null);
	useEffect(() => {
		if (!open) return;
		let live = true;
		const subscriptions = [
			onAuthenticated(() => {
				if (live) setSignedIn(true);
			}),
			onSignedOut(() => {
				if (live) setSignedIn(false);
			}),
		];
		void getSession({ cachedOnly: true }).then(
			(session) => {
				if (live) setSignedIn(Boolean(session));
			},
			() => {
				if (live) setSignedIn(false);
			},
		);
		return () => {
			live = false;
			for (const subscription of subscriptions)
				void subscription.then((stop) => stop()).catch(() => {});
		};
	}, [open]);
	return signedIn;
}

function CloudSignIn() {
	const { t } = useTranslation("sidebar");
	const [link, setLink] = useState<string | null>(null);
	return link ? (
		<Button asChild type="button">
			<a href={link} target="_blank" rel="noreferrer">
				{t("writing.cloudSignIn")}
			</a>
		</Button>
	) : (
		<Button
			type="button"
			onClick={() =>
				void requestAuth()
					.then((result) => {
						if (!result.opened) setLink(result.url);
					})
					.catch((error) => notifyError(errorText(error)))
			}
		>
			{t("writing.cloudSignIn")}
		</Button>
	);
}

const statusKeys = {
	connecting: "writing.cloudConnecting",
	offline: "writing.cloudOffline",
	saving: "writing.cloudSaving",
	saved: "writing.cloudSaved",
	denied: "writing.cloudDenied",
	error: "writing.cloudError",
} as const;

export function WritingCloudControl({
	vault,
	directory,
}: {
	vault: string;
	directory: string;
}) {
	const { t } = useTranslation("sidebar");
	const { session, state, pending } = useWritingCloudContext();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const signedIn = useCloudAccount(open);
	if (isMobileApp() || isRemoteVaultHandle(vault)) return null;
	const label = state ? t(statusKeys[state.status]) : t("writing.cloudProject");
	async function action() {
		setBusy(true);
		try {
			if (session) {
				await session.detach();
				notifySuccess(t("writing.cloudDetached"));
			} else {
				if (!(await flushAllTextEditors()))
					throw new Error(t("writing.cloudFileChanged"));
				await publishWritingCheckout(vault, directory);
				notifySuccess(t("writing.cloudPublished"));
			}
			setOpen(false);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="shrink-0"
					aria-label={label}
					title={label}
					disabled={pending}
				>
					{state?.status === "offline" || state?.status === "denied" ? (
						<CloudOff aria-hidden />
					) : (
						<Cloud aria-hidden />
					)}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogTitle>{t("writing.cloudProject")}</DialogTitle>
				<DialogDescription>
					{session ? label : t("writing.cloudPublishDescription")}
				</DialogDescription>
				{state?.conflict ? (
					<p className="text-sm">{t("writing.cloudConflicts")}</p>
				) : null}
				<DialogFooter>
					{signedIn === false ? <CloudSignIn /> : null}
					{signedIn && session ? (
						<Button asChild type="button" variant="outline">
							<a
								href={`${accountWebOrigin}/writing/${session.projectId}`}
								target="_blank"
								rel="noreferrer"
							>
								{t("writing.cloudOpenWeb")}
							</a>
						</Button>
					) : null}
					{signedIn ? (
						<Button
							type="button"
							disabled={busy || (Boolean(session) && state?.status !== "saved")}
							variant={session ? "outline" : "default"}
							onClick={() => void action()}
						>
							{busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
							{t(session ? "writing.cloudDetach" : "writing.cloudPublish")}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function WritingCloudDownloadButton({
	vault,
	collection,
}: {
	vault: string;
	collection: string;
}) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(false);
	const signedIn = useCloudAccount(open);
	const [projects, setProjects] = useState<CloudProject[] | null>(null);
	const [selection, setSelection] = useState<CloudProject | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const nameId = useId();
	useEffect(() => {
		if (!open || !signedIn) return;
		let live = true;
		setProjects(null);
		void listCloudProjects()
			.then((next) => {
				if (live)
					setProjects(next.filter((project) => project.status === "active"));
			})
			.catch((error) => {
				if (!live) return;
				notifyError(errorText(error));
				setProjects([]);
			});
		return () => {
			live = false;
		};
	}, [open, signedIn]);
	if (isMobileApp() || isRemoteVaultHandle(vault)) return null;
	async function download() {
		if (!selection || busy) return;
		setBusy(true);
		try {
			const root = await downloadWritingCheckout(
				vault,
				collection,
				selection,
				name,
			);
			setOpen(false);
			openWritingFile(root, root);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) setSelection(null);
				setOpen(next);
			}}
		>
			<TreeRowActionButton
				label={t("writing.cloudDownload")}
				trigger={(button) => <DialogTrigger asChild>{button}</DialogTrigger>}
			>
				<CloudDownload className="size-3.5" aria-hidden />
			</TreeRowActionButton>
			<DialogContent className="sm:max-w-md">
				<DialogTitle>{t("writing.cloudDownload")}</DialogTitle>
				<DialogDescription>
					{t("writing.cloudDownloadDescription")}
				</DialogDescription>
				{signedIn === false ? (
					<DialogFooter>
						<CloudSignIn />
					</DialogFooter>
				) : null}
				{signedIn && !projects ? (
					<Loader2
						className="size-4 animate-spin"
						aria-label={t("writing.loading")}
					/>
				) : null}
				{signedIn && projects?.length === 0 ? (
					<p className="text-sm">{t("writing.cloudEmpty")}</p>
				) : null}
				{signedIn && projects?.length ? (
					<div className="flex max-h-56 flex-col gap-1 overflow-auto">
						{projects.map((item) => (
							<Button
								key={item.id}
								type="button"
								variant={selection?.id === item.id ? "secondary" : "ghost"}
								aria-pressed={selection?.id === item.id}
								className="justify-start"
								onClick={() => {
									setSelection(item);
									setName(item.name);
								}}
							>
								{item.name}
							</Button>
						))}
					</div>
				) : null}
				{selection && signedIn ? (
					<form
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void download();
						}}
					>
						<label htmlFor={nameId}>{t("writing.projectName")}</label>
						<Input
							id={nameId}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
						<DialogFooter>
							<Button type="submit" disabled={busy || !name.trim()}>
								{t("writing.cloudDownload")}
							</Button>
						</DialogFooter>
					</form>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
