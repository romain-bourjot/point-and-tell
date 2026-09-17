---
name: point-and-tell
description: Collect notes a person points at in their own browser on the running app, then address the whole batch. Use when asked to fix, adjust or review screens by clicking on them live, to take a batch of remarks from the browser, or when told a batch is waiting on Go.
---

A helper on `:4488` serves an overlay into the page already open in the person's
browser. They click elements of the running app, write a note on each, and press
**Go**; the helper hands the whole batch over as one JSON line, and the report
written back at the end appears in their bar.

Nothing about the application changes: the overlay arrives from a bookmarklet,
lives in a shadow root, and is removed with the `×` in its bar.

`SKILL_DIR` below is this skill's own directory — the base directory named when
this skill was loaded. Run the commands from the project root, because that is
what the helper keys its state to.

## Prerequisites

Node 18 or newer (Bun runs it too), and the application already served on
localhost. `APP_URL` names its origin when it is not one of the usual dev ports —
3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080 on `localhost` and
`127.0.0.1`. `LIVE_PORT` moves the helper off `:4488`.

An element is named by whichever test attribute it carries — `data-testid`,
`data-test-id`, `data-test`, `data-cy`, `data-qa`, `data-pw`, `data-e2e`,
`data-automation-id`, in that order — and the note says which one it was.
`TEST_ID_ATTRS` replaces that list for a project that names its own.

Nothing is written into the repository: token, pid, log and batches live in a
temporary directory keyed by the project's path, which `start` and `status`
print. `LIVE_STATE_DIR` moves it.

## The loop

```bash
node "$SKILL_DIR/live.mjs" start
```

Prints the install page, the bookmarklet and a `console` one-liner. Give the
person the install page URL: they drag the button to their bookmarks bar once,
then click it on any screen of the app. Then block on the batch:

```bash
node "$SKILL_DIR/live.mjs" wait
```

One JSON line comes back when Go is pressed, or `{"type":"timeout"}` after
thirty minutes:

```json
{"type":"batch","id":"b1","sentAt":"2026-09-17T09:12:44.104Z","notes":[
  {"n":1,"note":"this button is too wide","route":"/orders?view=open",
   "testid":"search-submit","testAttribute":"data-cy",
   "testids":["orders","search","search-submit"],
   "tag":"button","text":"Search","rect":{"x":412,"y":233,"w":160,"h":44},"…":"…"}]}
```

Address every note — that is the point of the batch, and a note left alone is a
person waiting on a bar that says Claude is working. Run whatever this project
checks with, commit the way it commits, then say what happened:

```bash
node "$SKILL_DIR/live.mjs" report --text "1. button is w-auto now
2. label fixed in the copy bundle"
```

The bar shows that text and drops the pins. `--id b1` targets an older batch;
without it the last one is assumed.

| command | what it does |
|---|---|
| `start` | Boots the helper detached, waits for `/health`, prints the bookmarklet. Idempotent. |
| `wait [--timeout MS]` | Blocks until Go and prints the batch as one JSON line. Default 30 minutes. |
| `report --text "…" [--id b1]` | Sends the report to the bar. |
| `status` | Helper, port, project, and every batch with its state — `WAITING FOR THE AGENT` is one nobody picked up. |
| `stop` | Kills the helper. Batches on disk survive. |
| `serve` | Runs the helper in the foreground, for reading its log live. |

## What a note carries

The person points at pixels; the note carries what is needed to find the same
thing in the source. Per note: `n` (their numbering, and the number on the pin),
`note` (what they wrote), and the descriptor of the element —

- `route`, the `pathname` plus the query string, because `?view=open` is a screen
  of its own;
- `testid`, the nearest test id at or above the element, `testAttribute`, the
  attribute it was written under, `testids`, the whole chain from `body` down,
  and `ownTestid` / `ownTestAttribute`, the element's own or `null`;
- `tag`, `classes`, `slots` (up to three `data-slot`, which name the design-system
  primitive in play), `role`, `ariaLabel`;
- `text`, the first 200 characters it renders, and `outerHTML`, the first 1500;
- `rect` and `viewport`, so a complaint about width or overlap has numbers.

## Finding what a note is about

In this order, stopping at the first that lands:

1. **`testid`, then `testids`.** Where the project uses test ids, one of them is
   the element itself, and `testAttribute` says which spelling to grep for:
   `grep -rn 'data-cy="search-submit"' src` lands on it. When the element carries
   none, the chain names the composition it sits in.
2. **`route`.** Map it through the router — a routes file, a file-system route,
   or a screen component named after it — to the one file that renders it.
3. **`text`, in one or two hops.** A sentence rendered by a component is often
   not written in it: in a localized project, grep the sentence in the copy
   bundle for its key, then grep the key. `text` is copied from the DOM, so its
   punctuation is what the bundle actually holds, typographic apostrophes
   included.
4. **`classes` and `slots`.** A complaint about shape rather than content is
   usually about the primitive, not the screen: `slots` names it, and `classes`
   says what the call site added.

Then the change belongs where this project's own conventions put it — copy in
the bundle, layout in the screen, shape in the primitive. Read `CLAUDE.md` or
`AGENTS.md` before editing a design system's vendored files: some projects own
them deliberately and expect a declared divergence.

## Gotchas

- **The bookmarklet is clicked once per page load.** A full reload drops the
  overlay; `sessionStorage` keeps the notes, so clicking it again brings the pins
  back. Hot module replacement does not reload the page, so the overlay survives
  the edits made while the person watches.
- **While the overlay is armed, the app is not clickable.** Every click,
  `mousedown` and `pointerdown` is swallowed so pointing at a control does not
  activate it. `Browse` in the bar and `Escape` both disarm it; `Comment` arms it
  again.
- **A note keeps its text when its element goes.** Navigating away or
  re-rendering hides the box, and it comes back when an element with the same
  `ownTestid` is uniquely on the same route. A note taken on something with no
  test id keeps everything but its box.
- **`elementFromPoint` returns the topmost element**, which is often a wrapper
  rather than the thing meant — the numbered pin shows what was caught, and
  `testids` carries the chain either way.
- **A batch survives the helper.** Each one is written to
  `<state>/batch-<id>.json` and reloaded at boot, so `wait` after a restart hands
  over what was missed instead of losing it.
- **One helper per project.** The state directory is keyed by the path the
  commands run from, so two repositories commenting at once keep their own
  batches — but they cannot both hold `:4488`. Give the second one `LIVE_PORT`.
- **The overlay's copy is not the project's copy.** It is a tool that happens to
  render in the same page; it does not go through the project's translation
  bundle and it is not subject to its interface rules.

## Troubleshooting

- **`refused: origin_refused`** in the bar: the page is on an origin the helper
  does not allow. It allows the dev ports listed above and its own port, and
  nothing else — an Origin is the browser's word and it is what keeps another tab
  from making Claude edit code. Set `APP_URL` to the origin the app is really on
  and restart the helper.
- **`refused: bad_token`**: the bookmark holds a token from another project.
  Re-open the install page for this one and drag the button again.
- **`refused: helper unreachable`**: the helper is down, or `start` never reached
  `/health`. The log in the state directory has its output.
- **`helper is down — node … live.mjs start`** from `wait`: nothing answers on
  `:4488`. `status` says the same; `stop` then `start` clears a stale pid file.
- **Go does nothing**: the bar is already `waiting`. A batch was sent and no
  report has come back — `status` names it, and `report --id` closes it.
- **The bar says Claude is working long after the work is done**: the report was
  never sent. It is the last step of the loop, not a courtesy.
