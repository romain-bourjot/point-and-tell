// The overlay: point at elements of the running application, write a note on
// each, send them all on Go. Served by live.mjs, which prepends the LIVE
// constant holding the helper's origin and token.
//
// Everything it appends carries an id starting with "point-and-tell", because
// that prefix is the whole of how it keeps from picking itself.

(() => {
	const PREFIX = "point-and-tell";
	const STORE = "point-and-tell-session";
	const SKIP = new Set([
		"HTML",
		"HEAD",
		"BODY",
		"SCRIPT",
		"STYLE",
		"LINK",
		"META",
		"NOSCRIPT",
		"BR",
	]);

	if (window.__pointAndTell !== undefined) {
		window.__pointAndTell.wake();
		return;
	}

	const host = document.createElement("div");
	host.id = PREFIX;
	host.style.cssText =
		"position:fixed;inset:0;z-index:2147483000;pointer-events:none";
	const shadow = host.attachShadow({ mode: "open" });
	document.body.append(host);

	shadow.innerHTML = `<style>
:host{font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:#f8fafc}
[hidden]{display:none !important}
button{font:inherit;border:1px solid #334155;background:#1e293b;color:inherit;
border-radius:6px;padding:3px 8px;cursor:pointer}
button:hover{background:#334155}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:#2563eb;border-color:#2563eb}
button.primary:hover{background:#1d4ed8}
#${PREFIX}-highlight{position:fixed;box-sizing:border-box;border:2px solid #2563eb;
border-radius:4px;pointer-events:none;display:none}
.box{position:fixed;box-sizing:border-box;border:2px dashed #2563eb;border-radius:4px;
pointer-events:none;background:rgb(37 99 235 / .07)}
.pin{position:fixed;min-width:20px;height:20px;padding:0 5px;border-radius:10px;
background:#2563eb;color:#fff;font-size:11px;font-weight:700;display:flex;
align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;
box-shadow:0 1px 4px rgb(2 6 23 / .5)}
#${PREFIX}-editor{position:fixed;width:300px;box-sizing:border-box;background:#0f172a;
border:1px solid #334155;border-radius:8px;padding:8px;pointer-events:auto;
box-shadow:0 8px 24px rgb(2 6 23 / .5);display:flex;flex-direction:column;gap:6px}
#${PREFIX}-target{color:#94a3b8;font-size:11px;overflow:hidden;text-overflow:ellipsis;
white-space:nowrap}
#${PREFIX}-text{font:inherit;background:#1e293b;color:inherit;border:1px solid #475569;
border-radius:6px;padding:6px;resize:vertical}
.row{display:flex;gap:6px}
.row .grow{flex:1}
#${PREFIX}-bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);
display:flex;align-items:center;gap:8px;max-width:min(92vw,760px);background:#0f172a;
border:1px solid #334155;border-radius:10px;padding:6px 8px;pointer-events:auto;
box-shadow:0 8px 24px rgb(2 6 23 / .45)}
#${PREFIX}-bar strong{color:#60a5fa}
#${PREFIX}-count{white-space:nowrap}
#${PREFIX}-hint{color:#94a3b8;overflow:hidden;text-overflow:ellipsis;
white-space:nowrap;flex:1;min-width:0}
</style>
<div id="${PREFIX}-highlight"></div>
<div id="${PREFIX}-badges"></div>
<div id="${PREFIX}-editor" hidden>
	<div id="${PREFIX}-target"></div>
	<textarea id="${PREFIX}-text" rows="4"
		placeholder="What should change here…"></textarea>
	<div class="row">
		<button id="${PREFIX}-save" type="button" class="primary grow">Add</button>
		<button id="${PREFIX}-delete" type="button" hidden>Delete</button>
		<button id="${PREFIX}-cancel" type="button">Cancel</button>
	</div>
</div>
<div id="${PREFIX}-bar">
	<strong>Notes</strong>
	<span id="${PREFIX}-count"></span>
	<span id="${PREFIX}-hint"></span>
	<button id="${PREFIX}-pick" type="button">Browse</button>
	<button id="${PREFIX}-go" type="button" class="primary">Go</button>
	<button id="${PREFIX}-clear" type="button">Clear</button>
	<button id="${PREFIX}-close" type="button" title="Remove the overlay">×</button>
</div>`;

	const find = (name) => shadow.getElementById(`${PREFIX}-${name}`);
	const highlight = find("highlight");
	const badges = find("badges");
	const editor = find("editor");
	const target = find("target");
	const text = find("text");
	const count = find("count");
	const hint = find("hint");
	const pickButton = find("pick");
	const goButton = find("go");

	const state = {
		notes: [],
		seq: 0,
		armed: true,
		phase: "idle",
		batchId: null,
		route: location.pathname + location.search,
	};
	let hovered = null;
	let editing = null;
	let frame = null;

	// ---------------------------------------------------------- the elements

	const route = () => location.pathname + location.search;

	const nearestTestid = (el) =>
		el.closest("[data-testid]")?.getAttribute("data-testid") ?? null;

	const describe = (el) => {
		const testids = [];
		const slots = [];
		for (
			let node = el;
			node !== null && node !== document.body;
			node = node.parentElement
		) {
			const testid = node.getAttribute("data-testid");
			if (testid !== null) testids.unshift(testid);
			const slot = node.getAttribute("data-slot");
			if (slot !== null && slots.length < 3) slots.push(slot);
		}
		const rect = el.getBoundingClientRect();
		return {
			route: route(),
			testid: testids.at(-1) ?? null,
			ownTestid: el.getAttribute("data-testid"),
			testids,
			tag: el.tagName.toLowerCase(),
			slots,
			classes: (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
			text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
			ariaLabel: el.getAttribute("aria-label"),
			role: el.getAttribute("role"),
			rect: {
				x: Math.round(rect.left),
				y: Math.round(rect.top),
				w: Math.round(rect.width),
				h: Math.round(rect.height),
			},
			viewport: { w: window.innerWidth, h: window.innerHeight },
			outerHTML: el.outerHTML.slice(0, 1500),
		};
	};

	const pick = (x, y) => {
		const el = document.elementFromPoint(x, y);
		if (el === null || el === host) return null;
		if (SKIP.has(el.tagName)) return null;
		const rect = el.getBoundingClientRect();
		if (rect.width < 6 || rect.height < 6) return null;
		return el;
	};

	// A note taken on another screen keeps its text and its descriptor; only its
	// box is missing, and it comes back when the element does.
	const rebind = (note) => {
		if (note.target.route !== route()) return null;
		if (note.target.ownTestid === null) return null;
		const escaped = note.target.ownTestid.replace(/["\\]/g, "\\$&");
		const found = document.querySelectorAll(`[data-testid="${escaped}"]`);
		return found.length === 1 ? found[0] : null;
	};

	// ------------------------------------------------------------- the chrome

	const plural = (n) =>
		n === 0 ? "no notes" : n === 1 ? "1 note" : `${n} notes`;

	const paintBar = (message) => {
		const waiting = state.phase === "waiting";
		count.textContent = message ?? plural(state.notes.length);
		pickButton.textContent = state.armed ? "Browse" : "Comment";
		pickButton.hidden = waiting;
		goButton.hidden = waiting;
		goButton.disabled = state.notes.length === 0;
		find("clear").hidden = waiting || state.notes.length === 0;
		if (!state.armed || waiting) hint.textContent = "";
	};

	const paintBadges = () => {
		badges.replaceChildren();
		for (const note of state.notes) {
			note.box = document.createElement("div");
			note.box.className = "box";
			note.pin = document.createElement("div");
			note.pin.className = "pin";
			note.pin.textContent = String(note.n);
			note.pin.title = note.textContent;
			note.pin.addEventListener("click", () => open(note.el, note));
			badges.append(note.box, note.pin);
		}
	};

	const place = () => {
		for (const note of state.notes) {
			if (note.box === undefined) continue;
			const el = note.el?.isConnected === true ? note.el : rebind(note);
			note.el = el;
			if (el === null || el === undefined) {
				note.box.hidden = true;
				note.pin.hidden = true;
				continue;
			}
			const rect = el.getBoundingClientRect();
			note.box.hidden = false;
			note.pin.hidden = false;
			note.box.style.left = `${rect.left}px`;
			note.box.style.top = `${rect.top}px`;
			note.box.style.width = `${rect.width}px`;
			note.box.style.height = `${rect.height}px`;
			note.pin.style.left = `${rect.left - 8}px`;
			note.pin.style.top = `${rect.top - 10}px`;
		}
	};

	const drawHighlight = (el) => {
		if (el === null) {
			highlight.style.display = "none";
			return;
		}
		const rect = el.getBoundingClientRect();
		highlight.style.display = "block";
		highlight.style.left = `${rect.left}px`;
		highlight.style.top = `${rect.top}px`;
		highlight.style.width = `${rect.width}px`;
		highlight.style.height = `${rect.height}px`;
	};

	const tick = () => {
		if (route() !== state.route) {
			state.route = route();
			for (const note of state.notes) note.el = null;
		}
		place();
		if (state.armed && hovered !== null && hovered.isConnected) {
			drawHighlight(hovered);
		}
		frame = window.requestAnimationFrame(tick);
	};

	// ------------------------------------------------------------- the editor

	const open = (el, note) => {
		if (state.phase === "waiting") return;
		if (el === null || el === undefined) return;
		editing = { el, note: note ?? null };
		const described = note?.target ?? describe(el);
		target.textContent = `${described.testid ?? described.tag} · ${described.text.slice(0, 48)}`;
		text.value = note?.textContent ?? "";
		find("delete").hidden = note === undefined;
		find("save").textContent = note === undefined ? "Add" : "Save";
		const rect = el.getBoundingClientRect();
		const left = Math.min(Math.max(8, rect.left), window.innerWidth - 308);
		const below = rect.bottom + 8;
		editor.style.left = `${left}px`;
		editor.style.top = `${below + 190 > window.innerHeight ? Math.max(8, rect.top - 198) : below}px`;
		editor.hidden = false;
		text.focus();
	};

	const close = () => {
		editing = null;
		editor.hidden = true;
	};

	const save = () => {
		if (editing === null) return;
		const written = text.value.trim();
		if (written === "") return;
		if (editing.note === null) {
			state.seq += 1;
			state.notes.push({
				n: state.seq,
				textContent: written,
				target: describe(editing.el),
				el: editing.el,
			});
			paintBadges();
		} else {
			editing.note.textContent = written;
			editing.note.pin.title = written;
		}
		close();
		remember();
		paintBar();
	};

	const drop = () => {
		if (editing?.note === null) return;
		state.notes = state.notes.filter((note) => note !== editing.note);
		close();
		paintBadges();
		remember();
		paintBar();
	};

	// -------------------------------------------------------------- the batch

	const remember = () => {
		window.sessionStorage.setItem(
			STORE,
			JSON.stringify({
				seq: state.seq,
				phase: state.phase,
				batchId: state.batchId,
				notes: state.notes.map((note) => ({
					n: note.n,
					textContent: note.textContent,
					target: note.target,
				})),
			}),
		);
	};

	const forget = () => {
		window.sessionStorage.removeItem(STORE);
	};

	const watch = async () => {
		while (state.phase === "waiting") {
			const response = await fetch(
				`${LIVE.origin}/report?id=${state.batchId}&token=${LIVE.token}`,
				{ cache: "no-store" },
			).catch(() => null);
			if (response === null || !response.ok) {
				state.phase = "idle";
				paintBar("the helper stopped answering — run live.mjs start again");
				return;
			}
			const body = await response.json().catch(() => null);
			if (body?.status === "done") {
				state.phase = "idle";
				state.armed = false;
				state.notes = [];
				state.seq = 0;
				state.batchId = null;
				paintBadges();
				forget();
				paintBar(body.text);
				return;
			}
		}
	};

	const send = async () => {
		if (state.notes.length === 0 || state.phase !== "idle") return;
		paintBar("sending…");
		const response = await fetch(`${LIVE.origin}/batch?token=${LIVE.token}`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({
				notes: state.notes.map((note) => ({
					n: note.n,
					note: note.textContent,
					...note.target,
				})),
			}),
		}).catch(() => null);
		const body = response === null ? null : await response.json().catch(() => null);
		if (body?.ok !== true) {
			paintBar(`refused: ${body?.error ?? "helper unreachable"}`);
			return;
		}
		state.phase = "waiting";
		state.batchId = body.id;
		state.armed = false;
		drawHighlight(null);
		remember();
		paintBar(`Claude is working on ${plural(state.notes.length)}…`);
		watch();
	};

	// ----------------------------------------------------------- the listeners

	const ours = (event) => event.target === host;

	const onMove = (event) => {
		if (!state.armed || ours(event)) return;
		hovered = pick(event.clientX, event.clientY);
		drawHighlight(hovered);
		hint.textContent =
			hovered === null
				? ""
				: (nearestTestid(hovered) ?? `<${hovered.tagName.toLowerCase()}>`);
	};

	const onClick = (event) => {
		if (!state.armed || ours(event)) return;
		event.preventDefault();
		event.stopPropagation();
		open(pick(event.clientX, event.clientY));
	};

	const swallow = (event) => {
		if (!state.armed || ours(event)) return;
		event.preventDefault();
		event.stopPropagation();
	};

	const onKey = (event) => {
		if (event.key === "Escape") {
			if (!editor.hidden) {
				close();
				return;
			}
			state.armed = false;
			drawHighlight(null);
			paintBar();
			return;
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !editor.hidden) {
			event.preventDefault();
			save();
		}
	};

	const listeners = [
		["mousemove", onMove],
		["click", onClick],
		["mousedown", swallow],
		["mouseup", swallow],
		["pointerdown", swallow],
		["keydown", onKey],
	];
	for (const [name, handler] of listeners) {
		document.addEventListener(name, handler, true);
	}

	find("save").addEventListener("click", save);
	find("delete").addEventListener("click", drop);
	find("cancel").addEventListener("click", close);
	find("go").addEventListener("click", send);
	find("clear").addEventListener("click", () => {
		state.notes = [];
		state.seq = 0;
		close();
		paintBadges();
		forget();
		paintBar();
	});
	pickButton.addEventListener("click", () => {
		state.armed = !state.armed;
		drawHighlight(null);
		paintBar();
	});
	find("close").addEventListener("click", () => unmount());

	const unmount = () => {
		for (const [name, handler] of listeners) {
			document.removeEventListener(name, handler, true);
		}
		window.cancelAnimationFrame(frame);
		host.remove();
		window.__pointAndTell = undefined;
	};

	// ------------------------------------------------------------- the restore

	const restored = (() => {
		const saved = window.sessionStorage.getItem(STORE);
		if (saved === null) return null;
		const parsed = JSON.parse(saved);
		return Array.isArray(parsed?.notes) ? parsed : null;
	})();

	if (restored !== null) {
		state.seq = restored.seq ?? restored.notes.length;
		state.notes = restored.notes.map((note) => ({ ...note, el: null }));
		if (restored.phase === "waiting" && restored.batchId !== null) {
			state.phase = "waiting";
			state.batchId = restored.batchId;
			state.armed = false;
			watch();
		}
	}

	window.__pointAndTell = {
		wake: () => {
			if (state.phase === "waiting") return;
			state.armed = true;
			paintBar();
		},
		unmount,
	};

	paintBadges();
	paintBar();
	frame = window.requestAnimationFrame(tick);
})();
