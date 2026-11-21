import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { commands } from "@/lib/core/bindings";
import { callResult } from "@/lib/core/ipc";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import {
	formatShortcut,
	type ShortcutDisplay,
	type ShortcutId,
	shortcutFromEvent,
	validateShortcutBinding,
} from "@/lib/shell/shortcuts";

// Cancellation must finish restoring the menu before another holder suspends it.
let nativeRecordingQueue = Promise.resolve();
let nativeRecordingHolds = 0;
function setNativeRecording(recording: boolean): Promise<void> {
	const request = nativeRecordingQueue.then(async () => {
		await callResult(() => commands.setMenuShortcutRecording(recording));
	});
	nativeRecordingQueue = request.catch(() => {});
	return request;
}

/** Keep native menu accelerators suspended while a search field or recorder is active. */
export function holdNativeMenuShortcuts(): {
	release: () => void;
	ready: Promise<void>;
} {
	if (!isTauri()) return { release: () => {}, ready: Promise.resolve() };
	nativeRecordingHolds += 1;
	const ready =
		nativeRecordingHolds === 1
			? setNativeRecording(true)
			: nativeRecordingQueue.then(() => {});
	let released = false;
	return {
		ready,
		release: () => {
			if (released) return;
			released = true;
			nativeRecordingHolds = Math.max(0, nativeRecordingHolds - 1);
			if (nativeRecordingHolds === 0) {
				void setNativeRecording(false).catch((error) => {
					notifyError(errorMessage(error));
				});
			}
		},
	};
}

type RecordingSession = {
	native: boolean;
	ready: boolean;
	releaseMenu?: () => void;
};

export function ShortcutRecorder({
	id,
	label,
	binding,
	error,
	onError,
	onRecord,
}: {
	id: ShortcutId;
	label: string;
	binding: ShortcutDisplay | null;
	error: string | null;
	onError: (error: string | null) => void;
	onRecord: (binding: ShortcutDisplay) => boolean;
}) {
	const { t } = useTranslation(["settings", "shortcuts"]);
	const [status, setStatus] = useState<"idle" | "preparing" | "recording">(
		"idle",
	);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const swallowedKey = useRef<string | null>(null);
	const sessionRef = useRef<RecordingSession | null>(null);
	const recording = status !== "idle";

	const release = useCallback(() => {
		const session = sessionRef.current;
		sessionRef.current = null;
		session?.releaseMenu?.();
	}, []);

	const stop = useCallback(() => {
		release();
		setStatus("idle");
	}, [release]);

	useEffect(() => release, [release]);

	useEffect(() => {
		if (!recording) return;
		const win = buttonRef.current?.ownerDocument.defaultView;
		const cancel = () => {
			stop();
			onError(null);
		};
		win?.addEventListener("blur", cancel);
		return () => win?.removeEventListener("blur", cancel);
	}, [recording, stop, onError]);

	const start = async () => {
		if (sessionRef.current) return;
		onError(null);
		const session: RecordingSession = { native: isTauri(), ready: false };
		sessionRef.current = session;
		if (!session.native) {
			session.ready = true;
			setStatus("recording");
			return;
		}
		setStatus("preparing");
		const hold = holdNativeMenuShortcuts();
		session.releaseMenu = hold.release;
		try {
			await hold.ready;
			if (sessionRef.current !== session) return;
			session.ready = true;
			setStatus("recording");
		} catch (error) {
			if (sessionRef.current !== session) return;
			stop();
			notifyError(errorMessage(error));
		}
	};

	return (
		<div className="flex max-w-64 flex-col items-end gap-1.5">
			<Button
				ref={buttonRef}
				type="button"
				variant="outline"
				size="sm"
				className={cn(
					"min-w-20 font-sans tabular-nums tracking-wide",
					recording && "border-ring bg-muted",
				)}
				data-shortcut-recording={recording ? "true" : undefined}
				aria-label={t("keyboard.edit", { command: label })}
				aria-pressed={recording}
				aria-busy={status === "preparing"}
				aria-invalid={Boolean(error)}
				aria-describedby={error ? `${id}-error` : undefined}
				onClick={(event) => {
					event.currentTarget.focus();
					void start();
				}}
				onBlur={() => {
					if (sessionRef.current) onError(null);
					stop();
				}}
				onKeyDownCapture={(event) => {
					const session = sessionRef.current;
					if (!session) return;
					event.stopPropagation();
					if (event.key === "Tab") {
						stop();
						onError(null);
						return;
					}
					event.preventDefault();
					swallowedKey.current = event.key;
					if (event.key === "Escape") {
						stop();
						onError(null);
						return;
					}
					if (
						!session.ready ||
						event.repeat ||
						["Meta", "Control", "Alt", "Shift"].includes(event.key)
					) {
						return;
					}
					const next = shortcutFromEvent(event.nativeEvent);
					if (!next || !validateShortcutBinding(next, id)) {
						onError(t("shortcuts:invalid"));
						return;
					}
					if (onRecord(next)) stop();
				}}
				onKeyUpCapture={(event) => {
					if (sessionRef.current || swallowedKey.current === event.key) {
						event.preventDefault();
						event.stopPropagation();
						swallowedKey.current = null;
					}
				}}
			>
				{status === "preparing" ? (
					t("shortcuts:preparing")
				) : recording ? (
					t("shortcuts:recording")
				) : binding?.key ? (
					<kbd className="font-sans">{formatShortcut(binding)}</kbd>
				) : (
					<span className="text-muted-foreground">
						{t("shortcuts:unbound")}
					</span>
				)}
			</Button>
			{error && (
				<p id={`${id}-error`} className="text-xs text-destructive" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
