# point-and-tell

A Claude Code plugin that lets you point at elements of your running app in
your own browser, write a note on each, and press **Go**. Claude takes the whole
batch at once, does the work, and writes back into the bar what it changed.

Every note carries the element's test id, route, classes and measurements, so
*this button is too wide* arrives with enough context to find the button in the
source and fix it.

## Features

- **Nothing added to your app.** A small helper on `127.0.0.1:4488` serves an
  overlay; a bookmarklet injects it into the page you already have open, inside
  a shadow root. The `×` in the bar removes it.
- **Nothing written to your repository.** Token, pid, log and batches live in a
  temporary directory keyed by the project path.
- **Batches, not one note at a time.** Point at ten things, press Go once, get
  one report back.
- **Notes that locate themselves.** Route with query string, nearest test id
  and the attribute it was written under, tag, classes, `data-slot` names,
  rendered text, a slice of `outerHTML`, and the bounding rectangle.
- **Survives hot reloads.** Hot module replacement keeps the overlay in place
  while your edits land. A full reload drops it; click the bookmark again and
  the notes come back from `sessionStorage`.
- **Locked to your dev server.** The helper answers `127.0.0.1` only, every
  request carries a token, and a batch is refused unless the browser's
  `Origin` is one you allow.

## Installation

Requires Node 18 or newer.

From the marketplace, inside Claude Code:

```
/plugin marketplace add romainbourjot/point-and-tell
/plugin install point-and-tell@point-and-tell
```

From a local checkout:

```bash
git clone https://github.com/romainbourjot/point-and-tell.git
```

```
/plugin marketplace add ./point-and-tell
/plugin install point-and-tell@point-and-tell
```

## Usage

1. Start your app the way you normally do.
2. Ask Claude for a live pass in whatever words come to you: *let me point at
   things*, *take my notes from the browser*, *a batch is waiting on Go*.
3. Claude boots the helper and gives you an install page. Drag the button to
   your bookmarks bar once.
4. Click the bookmark on any screen of your app. The bar appears.
5. Click an element, write what should change, press **Add**. Repeat.
6. Press **Go**. The bar says Claude is working. When the report comes back,
   the pins drop and the bar says what was done.

While the overlay is armed, clicks on the app are swallowed so pointing at a
control does not activate it. `Browse` (or `Escape`) disarms it so the app is
clickable again; `Comment` arms it back.

### What Claude receives

One JSON line per batch:

```json
{"type":"batch","id":"b1","sentAt":"2026-09-17T09:12:44.104Z","notes":[
  {"n":1,"note":"this button is too wide","route":"/orders?view=open",
   "testid":"search-submit","testAttribute":"data-cy",
   "testids":["orders","search","search-submit"],
   "tag":"button","text":"Search","rect":{"x":412,"y":233,"w":160,"h":44}}]}
```

Whichever attribute your project names elements with is the one that comes
back: `data-testid`, `data-cy`, `data-test` and five more are read in order,
and the note says which one matched so the grep it suggests is the right one.
The full field list and the lookup order Claude follows are in
[the skill](skills/point-and-tell/SKILL.md).

## Configuration

All settings are environment variables read by the helper.

| Variable | Default | What it does |
|---|---|---|
| `APP_URL` | Ports 3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080 on `localhost` and `127.0.0.1` | Comma-separated origins the helper accepts a batch from. |
| `LIVE_PORT` | `4488` | The helper's own port. Two projects at once need a second one. |
| `LIVE_STATE_DIR` | A temp directory keyed by the project path | Where token, pid, log and batches live. |
| `TEST_ID_ATTRS` | `data-testid`, `data-test-id`, `data-test`, `data-cy`, `data-qa`, `data-pw`, `data-e2e`, `data-automation-id` | The attributes an element may be named by, most specific first. |

If the bar shows `refused: origin_refused`, your app is on an origin the helper
does not allow. Set `APP_URL` to that origin and restart the helper. More
failure modes are covered in the skill's
[troubleshooting section](skills/point-and-tell/SKILL.md#troubleshooting).

## Running it by hand

The skill drives these commands; they also work from a terminal, run from the
project root:

```bash
node skills/point-and-tell/live.mjs start     # boot, print the bookmarklet
node skills/point-and-tell/live.mjs status    # helper, project, batches
node skills/point-and-tell/live.mjs wait      # block until Go, print the batch
node skills/point-and-tell/live.mjs report --text "what was done"
node skills/point-and-tell/live.mjs stop
```

## Development

```bash
npm ci
npx playwright install chromium
npm test
```

The suite drives a real Chromium against the helper and a fixture page carrying
three different test-id attributes. The overlay is the half only a browser
exercises, so that is what the tests hold. CI runs the same three commands on
every push and pull request.

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening one; the
suite is the same one CI runs.

## License

Distributed under the
[CeCILL-C Free Software License Agreement](LICENSE), version 1.0, a
weak-copyleft license governed by French law and compatible with the LGPL.
You may use it in any project; changes to point-and-tell itself must be
shared under the same terms.
