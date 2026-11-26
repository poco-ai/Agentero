import type { PdfEngine } from "@embedpdf/models";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { createPdfEngine, disposePdfEngine } from "@/lib/pdf/engine";

type PdfEngineContextValue = {
	engine: PdfEngine | null;
	isLoading: boolean;
	error: Error | null;
};

const IDLE_MS = 15_000;
const LOADING: PdfEngineContextValue = {
	engine: null,
	isLoading: true,
	error: null,
};
const PdfEngineContext = createContext<
	PdfEngineContextValue & { acquire?: () => () => void }
>(LOADING);

type EngineSession = {
	controller: AbortController;
	engine?: PdfEngine;
	holders: number;
	idleTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Shares one PDFium engine per window. The WASM heap retains its capacity
 * after documents close, so retire the engine once readers stop using it.
 */
export function PdfEngineHost({ children }: { children: ReactNode }) {
	const [state, setState] = useState(LOADING);
	const sessionRef = useRef<EngineSession | null>(null);

	const stop = useCallback(() => {
		const session = sessionRef.current;
		if (!session) return;
		sessionRef.current = null;
		clearTimeout(session.idleTimer);
		session.controller.abort();
		if (session.engine) disposePdfEngine(session.engine);
	}, []);
	useEffect(() => stop, [stop]);

	const acquire = useCallback(() => {
		const session = sessionRef.current ?? {
			controller: new AbortController(),
			holders: 0,
		};
		clearTimeout(session.idleTimer);
		if (sessionRef.current === null) {
			sessionRef.current = session;
			const { signal } = session.controller;
			void createPdfEngine(signal)
				.then((engine) => {
					if (signal.aborted) {
						disposePdfEngine(engine);
						return;
					}
					session.engine = engine;
					setState({ engine, isLoading: false, error: null });
				})
				.catch((error: unknown) => {
					if (signal.aborted) return;
					setState({
						engine: null,
						isLoading: false,
						error: error instanceof Error ? error : new Error(String(error)),
					});
				});
		}
		session.holders += 1;
		return () => {
			session.holders -= 1;
			if (session.holders || sessionRef.current !== session) return;
			session.idleTimer = setTimeout(() => {
				if (session.holders || sessionRef.current !== session) return;
				stop();
				// A reader reopened at the deadline must not see the retired engine.
				flushSync(() => setState(LOADING));
			}, IDLE_MS);
		};
	}, [stop]);

	return (
		<PdfEngineContext.Provider value={{ ...state, acquire }}>
			{children}
		</PdfEngineContext.Provider>
	);
}

export function usePdfEngineContext(): PdfEngineContextValue {
	const context = useContext(PdfEngineContext);
	const { acquire } = context;
	useLayoutEffect(() => acquire?.(), [acquire]);
	return context;
}
