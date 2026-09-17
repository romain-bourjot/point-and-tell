// The loop, end to end: a browser loads the overlay, comments two elements,
// presses Go, and the batch a waiting agent claims is what the person pointed
// at. Everything here drives the real helper and a real Chromium — the parts
// worth testing are the ones only a browser exercises.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

process.env.LIVE_STATE_DIR = mkdtempSync(
	resolve(tmpdir(), "point-and-tell-test-"),
);

const { serve } = await import("../skills/point-and-tell/live.mjs");

let helper;
let browser;
let at;

const token = () => helper.token;

const open = async () => {
	const page = await browser.newPage();
	await page.goto(`${at}/test?token=${token()}`);
	await page.locator("#point-and-tell-bar").waitFor();
	return page;
};

const comment = async (page, selector, text) => {
	await page.locator(selector).click();
	await page.locator("#point-and-tell-text").fill(text);
	await page.locator("#point-and-tell-save").click();
};

const claim = (timeout = 20000) =>
	fetch(`${at}/wait?timeout=${timeout}&token=${token()}`).then((response) =>
		response.json(),
	);

before(async () => {
	helper = await serve({ listenPort: 0, quiet: true });
	at = `http://127.0.0.1:${helper.port}`;
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	helper.server.close();
	rmSync(process.env.LIVE_STATE_DIR, { recursive: true, force: true });
});

describe("a batch", () => {
	it("carries every note the person wrote, on Go", async () => {
		const page = await open();
		await comment(
			page,
			'[data-testid="thing-one"]',
			"the first button is too wide",
		);
		await comment(
			page,
			'[data-cy="thing-two"]',
			"the second should be secondary",
		);

		assert.equal(
			await page.locator("#point-and-tell-count").textContent(),
			"2 notes",
		);

		const waiting = claim();
		await page.locator("#point-and-tell-go").click();
		const batch = await waiting;

		assert.equal(batch.type, "batch");
		assert.equal(batch.notes.length, 2);
		assert.equal(batch.notes[0].note, "the first button is too wide");
		assert.equal(batch.notes[1].note, "the second should be secondary");
		// The query string is part of the screen: `?view=open` is not `/orders`.
		assert.match(batch.notes[0].route, /^\/test\?token=/);
		assert.ok(batch.notes[0].rect.w >= 160);
		await page.close();
	});

	it("is handed to one agent only", async () => {
		const page = await open();
		await comment(page, '[data-testid="thing-one"]', "once");
		const waiting = claim();
		await page.locator("#point-and-tell-go").click();
		await waiting;

		const second = await fetch(`${at}/wait?timeout=300&token=${token()}`).then(
			(response) => response.json(),
		);
		assert.equal(second.type, "timeout");
		await page.close();
	});

	it("reaches the bar as a report when the work is done", async () => {
		const page = await open();
		await comment(page, '[data-testid="thing-one"]', "something");
		const waiting = claim();
		await page.locator("#point-and-tell-go").click();
		const batch = await waiting;

		await fetch(`${at}/report?token=${token()}`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ id: batch.id, text: "one note addressed" }),
		});

		await page
			.locator("#point-and-tell-count", { hasText: "one note addressed" })
			.waitFor({ timeout: 10000 });
		await page.close();
	});
});

describe("a note", () => {
	it("names the element under whichever test attribute it carries", async () => {
		const page = await open();
		await comment(page, '[data-testid="thing-one"]', "one");
		await comment(page, '[data-cy="thing-two"]', "two");
		await comment(page, '[data-test="thing-three"]', "three");
		const waiting = claim();
		await page.locator("#point-and-tell-go").click();
		const { notes } = await waiting;

		assert.deepEqual(
			notes.map((note) => [note.testAttribute, note.testid]),
			[
				["data-testid", "thing-one"],
				["data-cy", "thing-two"],
				["data-test", "thing-three"],
			],
		);
		// The chain is what places an unnamed element, so it holds every spelling.
		assert.deepEqual(notes[1].testids, ["fixture", "thing-two"]);
		await page.close();
	});

	it("falls back to the chain when the element itself is unnamed", async () => {
		const page = await open();
		await comment(page, "text=Nameless", "this one has no test id");
		const waiting = claim();
		await page.locator("#point-and-tell-go").click();
		const { notes } = await waiting;

		assert.equal(notes[0].ownTestid, null);
		assert.equal(notes[0].ownTestAttribute, null);
		// The nearest name above it is the composition it sits in.
		assert.equal(notes[0].testid, "fixture");
		assert.equal(notes[0].tag, "button");
		assert.equal(notes[0].text, "Nameless");
		await page.close();
	});

	it("comes back to its element after a reload", async () => {
		const page = await open();
		await comment(page, '[data-testid="thing-one"]', "still here");
		await page.reload();
		await page.evaluate(
			(url) => import(url),
			`${at}/overlay.js?token=${token()}&t=2`,
		);
		await page.locator("#point-and-tell-bar").waitFor();

		assert.equal(
			await page.locator("#point-and-tell-count").textContent(),
			"1 note",
		);
		const pin = page.locator("#point-and-tell-badges .pin");
		await pin.waitFor();
		const box = await pin.boundingBox();
		const button = await page
			.locator('[data-testid="thing-one"]')
			.boundingBox();
		assert.ok(Math.abs(box.x - (button.x - 8)) < 2);
		await page.close();
	});
});

describe("the guard", () => {
	it("refuses a batch without the token", async () => {
		const page = await open();
		const status = await page.evaluate(async (endpoint) => {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({ notes: [{ note: "no token" }] }),
			});
			return response.status;
		}, `${at}/batch?token=wrong`);

		assert.equal(status, 401);
		await page.close();
	});

	it("refuses a batch from an origin it does not serve", async () => {
		const response = await fetch(`${at}/batch?token=${token()}`, {
			method: "POST",
			headers: { "content-type": "text/plain", origin: "https://evil.example" },
			body: JSON.stringify({ notes: [{ note: "from another tab" }] }),
		});

		assert.equal(response.status, 403);
		assert.equal((await response.json()).error, "origin_refused");
	});

	it("refuses an empty batch", async () => {
		const response = await fetch(`${at}/batch?token=${token()}`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ notes: [] }),
		});

		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, "no_notes");
	});
});
