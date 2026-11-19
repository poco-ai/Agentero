import type { PdfEngine } from "@embedpdf/models";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { createPdfEngine, disposePdfEngine } from "@/lib/pdf/engine";

type PdfEngineContextValue = {
	engine: PdfEngine | null;
	isLoading: boolean;
	error: Error | null;
};

const PdfEngineContext = createContext<
	PdfEngineContextValue & { start?: () => void }
>({
	engine: null,
	isLoading: true,
	error: null,
});

function useAgenteroPdfEngine(active: boolean): PdfEngineContextValue {
	const [state, setState] = useState<PdfEngineContextValue>({
		engine: null,
		isLoading: true,
		error: null,
	});

	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		let current: PdfEngine | null = null;

		createPdfEngine(controller.signal)
			.then((engine) => {
				if (controller.signal.aborted) {
					disposePdfEngine(engine);
					return;
				}
				current = engine;
				setState({ engine, isLoading: false, error: null });
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				setState({
					engine: null,
					isLoading: false,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			});

		return () => {
			controller.abort();
			if (current) disposePdfEngine(current);
			current = null;
		};
	}, [active]);

	return state;
}

/**
 * Creates the PDFium (WASM) engine once for the whole workspace window and
 * shares it with every PDF tab via context. PDFium holds many documents
 * concurrently, so a single engine backs all `<EmbedPDF>` providers.
 */
export function PdfEngineHost({ children }: { children: ReactNode }) {
	const [active, setActive] = useState(false);
	const start = useCallback(() => setActive(true), []);
	const { engine, isLoading, error } = useAgenteroPdfEngine(active);
	return (
		<PdfEngineContext.Provider value={{ engine, isLoading, error, start }}>
			{children}
		</PdfEngineContext.Provider>
	);
}

export function usePdfEngineContext(): PdfEngineContextValue {
	const context = useContext(PdfEngineContext);
	const { start } = context;
	useEffect(() => start?.(), [start]);
	return context;
}
