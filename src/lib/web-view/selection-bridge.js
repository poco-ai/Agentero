(() => {
	try {
		// Only the top-level proxied document talks to the app. A nested frame on
		// the same proxy origin has a readable parent and stays uninstrumented.
		try {
			if (parent === window) return;
			void parent.location.href;
			return;
		} catch {}
		const post = (message) => {
			message.source = "agentero-web";
			parent.postMessage(message, "*");
		};
		// ---- selection → app toolbar -----------------------------------------
		const MAX_SELECTION_CHARS = 4000;
		const sendSelection = () => {
			if (isEditable(document.activeElement)) return;
			let text = "";
			let rect = null;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
				text = (sel.toString() || "").trim().slice(0, MAX_SELECTION_CHARS);
				if (text) {
					const r = sel.getRangeAt(0).getBoundingClientRect();
					if (r.width !== 0 || r.height !== 0) {
						rect = { x: r.left, y: r.top, width: r.width, height: r.height };
					}
				}
			}
			if (text && rect) {
				// Raw copy inside the frame: the app's clipboard write can be refused
				// while focus sits in this cross-origin frame.
				try {
					document.execCommand("copy");
				} catch {}
			}
			post({ type: "selection", text: text, rect: rect, url: location.href });
		};
		const scheduleSelection = () => {
			// Let the browser finish updating the selection first.
			requestAnimationFrame(() => {
				setTimeout(sendSelection, 0);
			});
		};
		document.addEventListener("mouseup", scheduleSelection);
		document.addEventListener("keyup", (event) => {
			const key = event.key || "";
			if (
				key === "Shift" ||
				key.indexOf("Arrow") === 0 ||
				((event.metaKey || event.ctrlKey) && key.toLowerCase() === "a")
			)
				scheduleSelection();
		});

		// The app hides its toolbar while the page scrolls (plaza parity).
		let scrollPending = false;
		window.addEventListener(
			"scroll",
			() => {
				if (scrollPending) return;
				scrollPending = true;
				setTimeout(() => {
					scrollPending = false;
					post({ type: "scroll" });
				}, 150);
			},
			true,
		);

		// ---- shortcuts → app handlers -----------------------------------------
		// Keyboard events never bubble out of the frame. The app supplies effective
		// bindings and re-resolves forwarded keys against its live registry.
		let bindings = [];
		let isMac = false;
		const isEditable = (el) => {
			if (!el?.nodeName) return false;
			const name = el.nodeName.toLowerCase();
			return (
				name === "input" ||
				name === "textarea" ||
				name === "select" ||
				el.isContentEditable === true
			);
		};
		const matches = (event, def) => {
			let key = event.key || "";
			let defKey = def.key;
			if (key.length === 1) key = key.toLowerCase();
			if (defKey.length === 1) defKey = defKey.toLowerCase();
			const physicalKey = /^Key[A-Z]$/.test(event.code || "")
				? event.code.slice(3).toLowerCase()
				: null;
			if (
				key !== defKey &&
				event.key !== def.key &&
				!(def.alt && physicalKey === defKey)
			)
				return false;
			if (!!def.alt !== event.altKey || !!def.shift !== event.shiftKey)
				return false;
			if (isMac) {
				return !!def.meta === event.metaKey && !!def.ctrl === event.ctrlKey;
			}
			if (def.meta) return event.metaKey || event.ctrlKey;
			if (event.metaKey) return false;
			return !!def.ctrl === event.ctrlKey;
		};
		document.addEventListener(
			"keydown",
			(event) => {
				if (
					event.defaultPrevented ||
					event.isComposing ||
					isEditable(event.target)
				)
					return;
				for (let i = 0; i < bindings.length; i++) {
					const def = bindings[i];
					if (!matches(event, def)) continue;
					if (def.id !== "toggleChat") {
						const selection = window.getSelection();
						if (
							!selection ||
							selection.isCollapsed ||
							!selection.toString().trim()
						)
							return;
					}
					event.preventDefault();
					post({
						type: "shortcut",
						event: {
							key: event.key,
							code: event.code || "",
							metaKey: event.metaKey,
							ctrlKey: event.ctrlKey,
							altKey: event.altKey,
							shiftKey: event.shiftKey,
						},
					});
					return;
				}
			},
			true,
		);

		// ---- app → frame --------------------------------------------------------
		window.addEventListener("message", (event) => {
			const data = event.data;
			if (
				event.source !== parent ||
				!data ||
				data.source !== "agentero-web-host"
			)
				return;
			if (data.type === "shortcuts") {
				bindings = Array.isArray(data.bindings)
					? data.bindings.filter(
							(def) =>
								def &&
								typeof def.key === "string" &&
								(def.id === "toggleChat" ||
									def.id === "quickChat" ||
									def.id === "addSelectionToChat"),
						)
					: [];
				isMac = data.isMac === true;
			} else if (data.type === "clearSelection") {
				const sel = window.getSelection();
				if (sel) sel.removeAllRanges();
			} else if (data.type === "copySelection") {
				try {
					document.execCommand("copy");
				} catch {}
			}
		});
		post({ type: "ready" });
	} catch {}
})();
