#!/usr/bin/env node
// The helper behind the point-and-tell overlay: it serves the overlay to the
// browser, holds the batch the browser sends on Go, hands it to the agent, and
// carries the agent's report back to the bar.
//
//   node <skill>/live.mjs start
//   node <skill>/live.mjs wait
//   node <skill>/live.mjs report --text "…"
//   node <skill>/live.mjs status | stop | serve

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The project is wherever the agent ran this from, and the state belongs to
// that project rather than to this directory: a skill installed as a plugin is
// shared by every repository on the machine, and two of them commenting at once
// must not hand each other their batches.
const project = process.cwd();
const stateDir =
	process.env.LIVE_STATE_DIR ??
	resolve(
		tmpdir(),
		`point-and-tell-${createHash("sha1").update(project).digest("hex").slice(0, 10)}`,
	);
const tokenFile = resolve(stateDir, "token");
const pidFile = resolve(stateDir, "pid");
const logFile = resolve(stateDir, "log");

const port = Number(process.env.LIVE_PORT ?? 4488);

// Where the application under comment is served. `APP_URL` names it when the
// default list does not: an origin the browser will send is the only thing that
// gets past the guard, so a project on 5000 or on a hostname says so here.
const appPorts = [3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080];
const appOrigins =
	process.env.APP_URL === undefined
		? appPorts.flatMap((each) => [
				`http://localhost:${each}`,
				`http://127.0.0.1:${each}`,
			])
		: process.env.APP_URL.split(",")
				.map((each) => each.trim().replace(/\/$/, ""))
				.filter(Boolean);

// What a project names its elements with. Testing Library and Playwright read
// `data-testid`, Cypress's examples use `data-cy`, Vue Test Utils and much of the
// React world use `data-test`; the overlay takes the first one an element
// carries and says which it was, so the grep it suggests is the right one.
// `TEST_ID_ATTRS` replaces the list for a project that names its own.
const testAttributes =
	process.env.TEST_ID_ATTRS === undefined
		? [
				"data-testid",
				"data-test-id",
				"data-test",
				"data-cy",
				"data-qa",
				"data-pw",
				"data-e2e",
				"data-automation-id",
			]
		: process.env.TEST_ID_ATTRS.split(",")
				.map((each) => each.trim())
				.filter(Boolean);

const origin = `http://127.0.0.1:${port}`;

const usage = `point-and-tell — comment the running app, in batches

  start                  boot the helper and print the bookmarklet
  wait [--timeout MS]    block until Go, print the batch as one JSON line
  report --text "…"      tell the bar what was done (--id defaults to the last batch)
  status                 helper, port, batches
  stop                   kill the helper
  serve                  run the helper in the foreground
`;

const readToken = () => {
	mkdirSync(stateDir, { recursive: true });
	if (existsSync(tokenFile)) {
		return readFileSync(tokenFile, "utf8").trim();
	}
	const fresh = randomUUID();
	writeFileSync(tokenFile, `${fresh}\n`);
	return fresh;
};

const bookmarklet = (token, at = origin) =>
	`javascript:(()=>{const s=document.createElement('script');s.src='${at}/overlay.js?token=${token}&t='+Date.now();document.body.append(s);})()`;

// ---------------------------------------------------------------- the helper

export const serve = ({ listenPort = port, quiet = false } = {}) => {
	const token = readToken();
	// The port asked for is not always the port bound: a test asks for an
	// ephemeral one, and the overlay is served its own origin.
	let bound = listenPort;
	const batches = [];
	const reports = new Map();
	const batchWaiters = new Set();
	const reportWaiters = new Map();
	const overlay = readFileSync(resolve(here, "overlay.js"), "utf8");

	for (const name of readdirSync(stateDir).sort()) {
		if (!name.startsWith("batch-") || !name.endsWith(".json")) continue;
		const batch = JSON.parse(readFileSync(resolve(stateDir, name), "utf8"));
		batches.push(batch);
	}

	const persist = (batch) => {
		writeFileSync(
			resolve(stateDir, `batch-${batch.id}.json`),
			`${JSON.stringify(batch, null, "\t")}\n`,
		);
	};

	const nextId = () => {
		const used = batches.map((batch) => Number(batch.id.slice(1)));
		return `b${Math.max(0, ...used) + 1}`;
	};

	const claimBatch = () => {
		const batch = batches.find((candidate) => candidate.deliveredAt === null);
		if (batch === undefined) return null;
		batch.deliveredAt = new Date().toISOString();
		persist(batch);
		return batch;
	};

	const park = (waiters, timeoutMs) =>
		new Promise((done) => {
			const timer = setTimeout(() => {
				waiters.delete(entry);
				done(null);
			}, timeoutMs);
			const entry = (value) => {
				clearTimeout(timer);
				waiters.delete(entry);
				done(value);
			};
			waiters.add(entry);
		});

	const wake = (waiters, value) => {
		for (const entry of [...waiters]) entry(value);
	};

	const allowed = new Set(appOrigins);

	const readBody = (request) =>
		new Promise((done) => {
			let text = "";
			request.on("data", (chunk) => {
				text += chunk;
			});
			request.on("end", () => done(text));
		});

	const answer = (response, status, body, headers = {}) => {
		response.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		});
		response.end(`${JSON.stringify(body)}\n`);
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url, origin);
		const from = request.headers.origin;
		// A page's Origin is the browser's word, not the page's, so it is what
		// keeps another tab from posting a batch. A request without one is a
		// local process, and the token is what answers for those.
		const cors =
			from === undefined
				? {}
				: allowed.has(from)
					? { "access-control-allow-origin": from, vary: "origin" }
					: null;
		if (cors === null) {
			answer(response, 403, { error: "origin_refused", origin: from });
			return;
		}

		if (request.method === "OPTIONS") {
			response.writeHead(204, {
				...cors,
				"access-control-allow-headers": "content-type",
				"access-control-allow-methods": "GET, POST, OPTIONS",
			});
			response.end();
			return;
		}

		const path = url.pathname;

		if (path === "/health") {
			answer(response, 200, { ok: true, port: bound, project }, cors);
			return;
		}

		if (path === "/" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			});
			response.end(installPage(token, `http://127.0.0.1:${bound}`));
			return;
		}

		if (url.searchParams.get("token") !== token) {
			answer(response, 401, { error: "bad_token" }, cors);
			return;
		}

		if (path === "/overlay.js" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-store",
				...cors,
			});
			const head = `const LIVE = ${JSON.stringify({
				token,
				origin: `http://127.0.0.1:${bound}`,
				testAttributes,
			})};\n`;
			response.end(head + overlay);
			return;
		}

		if (path === "/test" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			});
			response.end(fixturePage(token));
			return;
		}

		if (path === "/batch" && request.method === "POST") {
			const text = await readBody(request);
			const payload = JSON.parse(text);
			if (!Array.isArray(payload.notes) || payload.notes.length === 0) {
				answer(response, 400, { error: "no_notes" }, cors);
				return;
			}
			const batch = {
				id: nextId(),
				sentAt: new Date().toISOString(),
				deliveredAt: null,
				notes: payload.notes,
			};
			batches.push(batch);
			persist(batch);
			if (!quiet)
				console.log(`[live] ${batch.id}: ${batch.notes.length} note(s)`);
			wake(batchWaiters, null);
			answer(response, 200, { ok: true, id: batch.id }, cors);
			return;
		}

		if (path === "/wait" && request.method === "GET") {
			const claimed = claimBatch();
			if (claimed !== null) {
				answer(response, 200, { type: "batch", ...claimed }, cors);
				return;
			}
			const timeoutMs = Number(url.searchParams.get("timeout") ?? 240000);
			await park(batchWaiters, timeoutMs);
			const woken = claimBatch();
			answer(
				response,
				200,
				woken === null ? { type: "timeout" } : { type: "batch", ...woken },
				cors,
			);
			return;
		}

		if (path === "/report" && request.method === "POST") {
			const text = await readBody(request);
			const payload = JSON.parse(text);
			const id = payload.id ?? batches.at(-1)?.id;
			if (id === undefined) {
				answer(response, 400, { error: "no_batch" }, cors);
				return;
			}
			reports.set(id, payload.text);
			wake(reportWaiters.get(id) ?? new Set(), payload.text);
			if (!quiet) console.log(`[live] ${id} reported`);
			answer(response, 200, { ok: true, id }, cors);
			return;
		}

		if (path === "/report" && request.method === "GET") {
			const id = url.searchParams.get("id");
			if (reports.has(id)) {
				answer(response, 200, { status: "done", text: reports.get(id) }, cors);
				return;
			}
			if (!reportWaiters.has(id)) reportWaiters.set(id, new Set());
			const timeoutMs = Number(url.searchParams.get("timeout") ?? 25000);
			const text = await park(reportWaiters.get(id), timeoutMs);
			answer(
				response,
				200,
				text === null ? { status: "pending" } : { status: "done", text },
				cors,
			);
			return;
		}

		if (path === "/status") {
			answer(
				response,
				200,
				{
					ok: true,
					port: bound,
					project,
					batches: batches.map((batch) => ({
						id: batch.id,
						notes: batch.notes.length,
						sentAt: batch.sentAt,
						deliveredAt: batch.deliveredAt,
						reported: reports.has(batch.id),
					})),
				},
				cors,
			);
			return;
		}

		answer(response, 404, { error: "no_such_route", path }, cors);
	});

	return new Promise((done) => {
		server.on("error", (error) => {
			console.error(`[live] ${error.message}`);
			process.exit(1);
		});
		server.listen(listenPort, "127.0.0.1", () => {
			bound = server.address().port;
			allowed.add(`http://localhost:${bound}`);
			allowed.add(`http://127.0.0.1:${bound}`);
			if (!quiet) console.log(`[live] http://127.0.0.1:${bound}`);
			done({ server, token, port: bound, batches, reports });
		});
	});
};

const installPage = (token, at) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>point-and-tell</title>
<style>
body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#0f172a;
background:#f8fafc;margin:0;padding:3rem;max-width:44rem}
a.mark{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;
padding:.5rem .9rem;border-radius:.5rem;font-weight:600}
code{background:#e2e8f0;padding:.1rem .3rem;border-radius:.25rem}
ul{padding-left:1.1rem}
</style></head>
<body>
<h1>point-and-tell</h1>
<p>Drag this button to your bookmarks bar, then click it on a page of your
running app to start pointing at things.</p>
<p><a class="mark" href="${bookmarklet(token, at)}">point-and-tell</a></p>
<p>Or paste this in the browser console:</p>
<p><code>await import("${at}/overlay.js?token=${token}")</code></p>
<p>The helper answers pages served from:</p>
<ul>${appOrigins.map((each) => `<li><code>${each}</code></li>`).join("")}</ul>
<p>Set <code>APP_URL</code> and restart the helper when your app is somewhere
else.</p>
</body></html>
`;

const fixturePage = (token) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>point-and-tell fixture</title></head>
<body>
<main data-testid="fixture">
<h1 data-testid="fixture-title">The title of the page</h1>
<button type="button" data-testid="thing-one"
style="width:160px;height:44px">First</button>
<button type="button" data-cy="thing-two"
style="width:160px;height:44px">Second</button>
<button type="button" data-test="thing-three"
style="width:160px;height:44px">Third</button>
<button type="button" style="width:160px;height:44px">Nameless</button>
</main>
<script src="/overlay.js?token=${token}"></script>
</body></html>
`;

// ------------------------------------------------------------------ the CLI

const ask = async (path, init) => {
	const token = readToken();
	const glue = path.includes("?") ? "&" : "?";
	const response = await fetch(
		`${origin}${path}${glue}token=${token}`,
		init,
	).catch(() => null);
	if (response === null) return null;
	return await response.json().catch(() => null);
};

const helperUp = async () => (await ask("/health"))?.ok === true;

const start = async () => {
	const token = readToken();
	if (await helperUp()) {
		console.log(`helper already up on ${origin}`);
	} else {
		mkdirSync(stateDir, { recursive: true });
		const log = openSync(logFile, "a");
		const child = spawn(
			process.execPath,
			[fileURLToPath(import.meta.url), "serve"],
			{
				cwd: project,
				detached: true,
				stdio: ["ignore", log, log],
			},
		);
		child.unref();
		writeFileSync(pidFile, `${child.pid}\n`);
		for (let attempt = 0; attempt < 60; attempt += 1) {
			if (await helperUp()) break;
			await new Promise((done) => setTimeout(done, 100));
		}
		if (!(await helperUp())) {
			console.error(
				`helper never answered on ${origin}/health — see ${logFile}`,
			);
			process.exit(1);
		}
		console.log(`helper up on ${origin}`);
	}
	console.log(`\ninstall page  ${origin}/`);
	console.log(`bookmarklet   ${bookmarklet(token)}`);
	console.log(
		`console       await import("${origin}/overlay.js?token=${token}")`,
	);
	console.log(`\nstate         ${stateDir}`);
	console.log(`app origins   ${appOrigins.join(" ")}`);
};

const wait = async (rest) => {
	const asked = Number(rest[rest.indexOf("--timeout") + 1]);
	const deadline = Date.now() + (Number.isFinite(asked) ? asked : 1800000);
	if (!(await helperUp())) {
		console.error(`helper is down — node ${here}/live.mjs start`);
		process.exit(1);
	}
	while (Date.now() < deadline) {
		const chunk = Math.min(240000, deadline - Date.now());
		const body = await ask(`/wait?timeout=${chunk}`);
		if (body === null) {
			console.error("helper stopped answering");
			process.exit(1);
		}
		if (body.type === "batch") {
			console.log(JSON.stringify(body));
			return;
		}
	}
	console.log(JSON.stringify({ type: "timeout" }));
};

const report = async (rest) => {
	const text = rest[rest.indexOf("--text") + 1];
	const id = rest.includes("--id") ? rest[rest.indexOf("--id") + 1] : undefined;
	if (rest.indexOf("--text") === -1 || text === undefined) {
		console.error('report needs --text "what was done"');
		process.exit(1);
	}
	const body = await ask("/report", {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body: JSON.stringify({ id, text }),
	});
	if (body?.ok !== true) {
		console.error(`report refused: ${JSON.stringify(body)}`);
		process.exit(1);
	}
	console.log(`reported on ${body.id}`);
};

const status = async () => {
	const body = await ask("/status");
	if (body === null) {
		console.log(`helper down (nothing answers on ${origin})`);
		console.log(`state ${stateDir}`);
		return;
	}
	if (!Array.isArray(body.batches)) {
		console.log(
			`something else answers on ${origin} — stop it, or set LIVE_PORT`,
		);
		return;
	}
	console.log(`helper up on ${origin} for ${body.project}`);
	if (body.batches.length === 0) {
		console.log("no batch yet");
		return;
	}
	for (const batch of body.batches) {
		const state = batch.reported
			? "reported"
			: batch.deliveredAt === null
				? "WAITING FOR THE AGENT"
				: "with the agent";
		console.log(`  ${batch.id}  ${batch.notes} note(s)  ${state}`);
	}
};

const stop = async () => {
	if (!existsSync(pidFile)) {
		console.log("no pid file — nothing to stop");
		return;
	}
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	const killed = (() => {
		try {
			process.kill(pid, "SIGTERM");
			return true;
		} catch {
			return false;
		}
	})();
	rmSync(pidFile);
	console.log(killed ? `stopped ${pid}` : `${pid} was already gone`);
};

// ------------------------------------------------------------------ dispatch

// Imported by the repository's tests, which call `serve` themselves; run as a
// file, it is the CLI the skill drives.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command = "status", ...rest] = process.argv.slice(2);

	if (command === "serve") {
		await serve();
	} else if (command === "start") {
		await start();
	} else if (command === "wait") {
		await wait(rest);
	} else if (command === "report") {
		await report(rest);
	} else if (command === "status") {
		await status();
	} else if (command === "stop") {
		await stop();
	} else {
		console.error(usage);
		process.exit(1);
	}
}
