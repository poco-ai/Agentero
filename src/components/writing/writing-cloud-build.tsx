import {
	ArrowLeft,
	ArrowRight,
	Cloud,
	Loader2,
	ScrollText,
	Square,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { getTexEditorCursor } from "@/lib/tex/editor-navigation";
import { jumpWritingPdf, syncWritingPdfToSource } from "@/lib/tex/synctex";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault/path";
import { contentRequest, WritingApiError } from "@/lib/writing/cloud/api";
import {
	buildFinished,
	syncLocation,
	type WritingBuild,
	writingBuild,
	writingBuilds,
} from "@/lib/writing/cloud/protocol/builds";
import type { WritingCheckoutSession } from "@/lib/writing/cloud/session";
import { useWritingCloudContext } from "./writing-cloud-context";

const PdfViewer = lazy(async () => ({
	default: (await import("@/components/viewer/pdf/pdf-viewer")).PdfViewer,
}));

export function WritingCloudBuildPreview({
	local,
	sourcePath,
	rootFile,
	vaultPath,
	active,
	panelId,
	cloud,
	onCloudChange,
}: {
	local: ReactNode;
	sourcePath: string;
	rootFile: string;
	vaultPath: string;
	active: boolean;
	panelId: string;
	cloud: boolean;
	onCloudChange(cloud: boolean): void;
}) {
	const { t } = useTranslation("sidebar");
	const { session, state } = useWritingCloudContext();
	if (!session || !state) return local;
	if (cloud)
		return (
			<CloudBuild
				key={session.projectId}
				session={session}
				canBuild={state.role !== "viewer" && state.status !== "denied"}
				revision={state.revision}
				{...{ sourcePath, rootFile, vaultPath, active, panelId }}
				onLocal={() => onCloudChange(false)}
			/>
		);
	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="absolute top-0.5 right-1 z-20">
				<Button
					type="button"
					variant="secondary"
					size="icon-sm"
					aria-label={t("writing.cloudCompile")}
					title={t("writing.cloudCompile")}
					onClick={() => onCloudChange(true)}
				>
					<Cloud aria-hidden />
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col pr-0 [&>div:first-child]:pr-9">
				{local}
			</div>
		</div>
	);
}

function CloudBuild({
	session,
	canBuild,
	revision,
	sourcePath,
	rootFile,
	vaultPath,
	active,
	panelId,
	onLocal,
}: {
	session: WritingCheckoutSession;
	canBuild: boolean;
	revision: number;
	sourcePath: string;
	rootFile: string;
	vaultPath: string;
	active: boolean;
	panelId: string;
	onLocal(): void;
}) {
	const { t } = useTranslation("sidebar");
	const [latest, setLatest] = useState<WritingBuild | null>(null);
	const [pdf, setPdf] = useState<{
		build: WritingBuild;
		bytes: ArrayBuffer;
	} | null>(null);
	const [successful, setSuccessful] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [log, setLog] = useState<string | null>(null);
	const [builtRevision, setBuiltRevision] = useState<number | null>(null);
	const running = latest != null && !buildFinished(latest.status);
	const pdfPath = pdf ? `agentero-cloud-build/${pdf.build.buildId}.pdf` : null;

	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			let interval = 2500;
			try {
				const ticket = await session.accessTicket();
				const response = await contentRequest(
					ticket,
					session.projectId,
					"builds",
					{
						signal: AbortSignal.any([
							controller.signal,
							AbortSignal.timeout(10_000),
						]),
					},
				);
				const history = writingBuilds.parse(await response.json());
				if (controller.signal.aborted) return;
				const build = history.builds[0] ?? null;
				setLatest(build);
				setSuccessful(history.lastSuccessfulBuildId);
				if (build && !buildFinished(build.status)) interval = 750;
			} catch (error) {
				if (controller.signal.aborted) return;
				if (
					error instanceof WritingApiError &&
					[401, 403, 404].includes(error.status)
				) {
					notifyError(errorText(error));
					return;
				}
				interval = 5000;
			}
			timer = setTimeout(() => void poll(), interval);
		};
		void poll();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [session]);

	useEffect(() => {
		if (!successful) return;
		const controller = new AbortController();
		void (async () => {
			try {
				const ticket = await session.accessTicket();
				const [meta, bytes] = await Promise.all([
					contentRequest(ticket, session.projectId, `builds/${successful}`, {
						signal: controller.signal,
					}).then(async (response) =>
						writingBuild.parse(await response.json()),
					),
					contentRequest(
						ticket,
						session.projectId,
						`builds/${successful}/artifacts/pdf`,
						{ signal: controller.signal },
					).then((response) => response.arrayBuffer()),
				]);
				if (!controller.signal.aborted) setPdf({ build: meta, bytes });
			} catch (error) {
				if (!controller.signal.aborted) notifyError(errorText(error));
			}
		})();
		return () => controller.abort();
	}, [session, successful]);

	async function start() {
		setBusy(true);
		try {
			const checkpoint = await session.durableCheckpoint();
			const ticket = await session.accessTicket();
			const response = await contentRequest(
				ticket,
				session.projectId,
				"builds",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": crypto.randomUUID(),
					},
					body: JSON.stringify({ checkpoint }),
				},
			);
			const build = writingBuild.parse(await response.json());
			setLatest(build);
			if (build.status === "succeeded") setSuccessful(build.buildId);
			setBuiltRevision(revision);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setBusy(false);
		}
	}

	async function cancel() {
		if (!latest) return;
		try {
			const response = await contentRequest(
				await session.accessTicket(),
				session.projectId,
				`builds/${latest.buildId}/cancel`,
				{ method: "POST" },
			);
			setLatest(writingBuild.parse(await response.json()));
		} catch (error) {
			notifyError(errorText(error));
		}
	}

	async function readLog() {
		if (!latest) return;
		try {
			const result = await contentRequest(
				await session.accessTicket(),
				session.projectId,
				`builds/${latest.buildId}/artifacts/log`,
			);
			setLog(await result.text());
		} catch (error) {
			notifyError(errorText(error));
		}
	}

	async function sync(direction: "forward" | "backward", point: object) {
		if (!pdf) return null;
		if (builtRevision == null || revision !== builtRevision)
			notifyError(t("writing.cloudBuildOlderSource"));
		const result = await contentRequest(
			await session.accessTicket(),
			session.projectId,
			`builds/${pdf.build.buildId}/synctex/${direction}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(point),
			},
		);
		return syncLocation.nullable().parse(await result.json());
	}

	async function jumpForward() {
		const cursor = getTexEditorCursor(sourcePath) ?? getTexEditorCursor();
		const path = cursor
			? vaultRelativePath(session.rootDirectory, cursor.path)
			: null;
		if (!pdfPath || !cursor || !path) return;
		try {
			const target = await sync("forward", { path, line: cursor.line });
			if (!target) {
				notifyError(t("writing.cloudBuildNoMatch"));
				return;
			}
			jumpWritingPdf(pdfPath, {
				page: target.page,
				x: target.x,
				y: target.y,
				width: 12,
				height: 8,
			});
		} catch (error) {
			notifyError(errorText(error));
		}
	}

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/70 px-1">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("writing.localCompile")}
					title={t("writing.localCompile")}
					onClick={onLocal}
				>
					<ArrowLeft aria-hidden />
				</Button>
				<Button
					size="sm"
					disabled={!canBuild || busy || running}
					onClick={() => void start()}
				>
					{busy || running ? (
						<Loader2 className="animate-spin" aria-hidden />
					) : (
						<Cloud aria-hidden />
					)}
					{t("writing.cloudCompile")}
				</Button>
				{canBuild && running ? (
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={t("writing.cloudBuildCancel")}
						onClick={() => void cancel()}
					>
						<Square aria-hidden />
					</Button>
				) : null}
				{latest?.artifacts.some((item) => item.kind === "log") ? (
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={t("writing.cloudBuildLog")}
						onClick={() => void readLog()}
					>
						<ScrollText aria-hidden />
					</Button>
				) : null}
				{pdf && (
					<>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={t("writing.cloudBuildLocate")}
							onClick={() => void jumpForward()}
						>
							<ArrowRight aria-hidden />
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={t("writing.cloudBuildLocateSource")}
							onClick={() => syncWritingPdfToSource()}
						>
							<ArrowLeft aria-hidden />
						</Button>
					</>
				)}
			</div>
			{latest ? (
				<div
					className="flex shrink-0 flex-wrap gap-x-2 border-b border-border px-2 py-1 text-xs text-muted-foreground"
					aria-live="polite"
				>
					{t(`writing.cloudBuildStatus.${latest.status}`)}
					{pdf ? (
						<span>
							{t("writing.cloudBuildVersion", {
								version: pdf.build.checkpoint.serverSeq,
							})}
						</span>
					) : null}
					{latest.diagnostics[0] ? (
						<span className="text-destructive">
							{latest.diagnostics[0].message}
						</span>
					) : null}
				</div>
			) : null}
			<div className="min-h-0 flex-1">
				{pdf && pdfPath ? (
					<Suspense
						fallback={
							<p className="p-3 text-sm">{t("writing.previewLoading")}</p>
						}
					>
						<PdfViewer
							key={pdfPath}
							source={null}
							sourceBytes={pdf.bytes}
							docId={`${panelId}:${pdfPath}`}
							vaultPath={vaultPath}
							isActive={active}
							plainViewer
							showBottomBar
							texRootPath={rootFile}
							pdfPath={pdfPath}
							syncTexScope="writing"
							className="h-full w-full"
							cloudSyncBackward={async (page, x, y) => {
								const target = await sync("backward", { page, x, y });
								return target
									? {
											path: joinVaultPath(session.rootDirectory, target.path),
											line: target.line,
											column: 1,
										}
									: null;
							}}
						/>
					</Suspense>
				) : (
					<p className="p-3 text-sm text-muted-foreground">
						{t("writing.previewEmpty")}
					</p>
				)}
			</div>
			<Dialog
				open={log !== null}
				onOpenChange={(open) => {
					if (!open) setLog(null);
				}}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogTitle>{t("writing.cloudBuildLog")}</DialogTitle>
					<DialogDescription>
						{t("writing.cloudBuildLogDescription")}
					</DialogDescription>
					<pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap text-xs">
						{log}
					</pre>
				</DialogContent>
			</Dialog>
		</div>
	);
}
