export function keyEvent(
	type: "keydown" | "keyup" | "keypress",
	key: string,
	init: KeyboardEventInit = {},
): KeyboardEvent {
	return new KeyboardEvent(type, {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
}

export function pressKey(
	target: EventTarget,
	key: string,
	init: KeyboardEventInit = {},
): KeyboardEvent {
	const event = keyEvent("keydown", key, init);
	target.dispatchEvent(event);
	return event;
}
