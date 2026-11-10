import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { accountSurfaceEnabled } from "@/features/account/visibility";
import { useWritingProject } from "@/hooks/use-writing-project";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isMobileApp } from "@/lib/core/tauri";
import { vaultRelativePath } from "@/lib/vault/path";
import { onCheckoutChange } from "@/lib/writing/cloud/checkout";
import {
	openWritingCheckout,
	type WritingCheckoutSession,
} from "@/lib/writing/cloud/session";

const CloudWritingContext = createContext<{
	session: WritingCheckoutSession | null;
	pending: boolean;
}>({ session: null, pending: false });
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function useWritingCloudContext() {
	const { session, pending } = useContext(CloudWritingContext);
	const state = useSyncExternalStore(
		session?.subscribe ?? emptySubscribe,
		session?.getSnapshot ?? emptySnapshot,
	);
	return { session, state, pending };
}

export function useSharedWritingEditor(path: string) {
	const { session, state, pending } = useWritingCloudContext();
	if (!session || !state) return { session: null, shared: null, pending };
	const relative = vaultRelativePath(session.rootDirectory, path);
	const text = relative ? session.textAt(relative) : null;
	return {
		session,
		pending: false,
		shared: text
			? {
					text,
					awareness: session.awareness,
					readOnly: state.role === "viewer" || state.status === "denied",
					flush: session.flush,
				}
			: null,
	};
}

type WritingCloudProviderProps = {
	vault: string;
	root: string;
	children: ReactNode;
};

export function WritingCloudProvider(props: WritingCloudProviderProps) {
	if (!accountSurfaceEnabled || isMobileApp()) return props.children;
	return <ActiveWritingCloudProvider {...props} />;
}

function ActiveWritingCloudProvider({
	vault,
	root,
	children,
}: WritingCloudProviderProps) {
	const { t } = useTranslation("sidebar");
	const lookup = useWritingProject(vault, root);
	const project = lookup.status === "ready" ? lookup.project : null;
	const [session, setSession] = useState<WritingCheckoutSession | null>(null);
	const [resolved, setResolved] = useState("");
	const projectKey = project
		? `${vault}:${project.directory}:${project.manifest.projectId}`
		: "";
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!project) {
			if (lookup.status === "ready") {
				setSession(null);
				setResolved("");
				setFailed(false);
			}
			return;
		}
		let current = true;
		const load = () => {
			void openWritingCheckout(vault, project)
				.then((next) => {
					if (!current) return;
					setSession(next);
					setResolved(projectKey);
					setFailed(false);
				})
				.catch((error) => {
					if (!current) return;
					setFailed(true);
					notifyError(errorText(error));
				});
		};
		load();
		const stop = onCheckoutChange(load);
		return () => {
			current = false;
			stop();
		};
	}, [vault, project, projectKey, lookup.status]);
	return (
		<CloudWritingContext.Provider
			value={{
				session:
					projectKey === resolved || lookup.status === "pending"
						? session
						: null,
				pending:
					failed ||
					lookup.status === "error" ||
					(lookup.status === "pending" && !session) ||
					(!!projectKey && projectKey !== resolved),
			}}
		>
			{failed ? (
				<div className="px-3 py-2 text-sm text-muted-foreground">
					{t("writing.cloudWindowBusy")}
				</div>
			) : (
				children
			)}
		</CloudWritingContext.Provider>
	);
}
