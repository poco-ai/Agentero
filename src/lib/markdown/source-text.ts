import { invertedEffects } from "@codemirror/commands";
import {
	type EditorState,
	MapMode,
	StateEffect,
	StateField,
} from "@codemirror/state";

type LineEndings = {
	preferred: string;
	exceptions: ReadonlyMap<number, string>;
};

const restoreEndings = StateEffect.define<ReadonlyMap<number, string>>({
	map(value, changes) {
		const mapped = new Map<number, string>();
		for (const [pos, ending] of value) {
			const next = changes.mapPos(pos, 1, MapMode.TrackAfter);
			if (next != null) mapped.set(next, ending);
		}
		return mapped;
	},
});

/** CodeMirror works in LF offsets. Remember non-default breaks at those offsets. */
export const sourceLineEndings = StateField.define<LineEndings>({
	create: () => ({ preferred: "\n", exceptions: new Map() }),
	update(value, { changes, docChanged, effects }) {
		const restored = effects.filter((effect) => effect.is(restoreEndings));
		if (!restored.length && (!docChanged || !value.exceptions.size))
			return value;
		const exceptions = new Map<number, string>();
		for (const [pos, ending] of value.exceptions) {
			const mapped = changes.mapPos(pos, 1, MapMode.TrackAfter);
			if (mapped != null) exceptions.set(mapped, ending);
		}
		for (const effect of restored) {
			for (const [pos, ending] of effect.value) exceptions.set(pos, ending);
		}
		return { ...value, exceptions };
	},
});

const restoreEndingsOnUndo = invertedEffects.of(({ startState, changes }) => {
	if (changes.empty) return [];
	const deleted = new Map<number, string>();
	for (const [pos, ending] of startState.field(sourceLineEndings).exceptions) {
		if (changes.mapPos(pos, 1, MapMode.TrackAfter) === null)
			deleted.set(pos, ending);
	}
	return deleted.size ? [restoreEndings.of(deleted)] : [];
});

export function sourceDocument(raw: string) {
	const preferred = /\r\n|\r|\n/.exec(raw)?.[0] ?? "\n";
	const exceptions = new Map<number, string>();
	let removed = 0;
	const doc = raw.replace(/\r\n|\r|\n/g, (ending: string, offset: number) => {
		if (ending !== preferred) exceptions.set(offset - removed, ending);
		removed += ending.length - 1;
		return "\n";
	});
	return {
		doc,
		endings: [
			sourceLineEndings.init(() => ({ preferred, exceptions })),
			restoreEndingsOnUndo,
		],
	};
}

export function readSourceDocument(state: EditorState): string {
	const { preferred, exceptions } = state.field(sourceLineEndings);
	const normalized = state.doc.toString();
	if (!exceptions.size && preferred === "\n") return normalized;
	return normalized.replace(
		/\n/g,
		(_, pos: number) => exceptions.get(pos) ?? preferred,
	);
}
