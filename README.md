# point-and-tell

Point at elements of your running app in your own browser, write a note on each,
press **Go**. Claude takes the whole batch at once, does the work, and writes
back into the bar what it changed.

No dependency, nothing added to your app, nothing written into your repository.
A small helper serves an overlay from `127.0.0.1:4488`; a bookmarklet injects it
into the page you already have open, in a shadow root, and the `×` in the bar
removes it.

## Install

```
/plugin marketplace add romainbourjot/point-and-tell
/plugin install point-and-tell@point-and-tell
```

A local checkout works the same way:

```
/plugin marketplace add ~/workspace/point-and-tell
/plugin install point-and-tell@point-and-tell
```

Node 18 or newer is all it runs on.

## Use

Start the app however you normally do, then ask Claude for a live pass — *let me
point at things*, *take my notes from the browser*, *a batch is waiting on Go*.
It boots the helper and hands you an install page: drag the button to your
bookmarks bar once, click it on any screen, and the bar appears.

Click an element, write what should change, **Add**. Repeat. **Go** sends the lot
and the bar says Claude is working; when the report comes back the pins drop and
the bar says what was done.

- `Browse` (or `Escape`) disarms the overlay so the app is clickable again;
  `Comment` arms it back.
- A full page reload drops the overlay — click the bookmark again and the notes
  come back from `sessionStorage`.
- Hot module replacement does not reload the page, so the overlay survives the
  edits you are watching land.

## What Claude receives

One JSON line per batch. Each note carries what the person wrote and enough of
the element to find it in the source: the route with its query string, the
nearest `data-testid` and the whole chain of them, the tag, classes and
`data-slot` names, the rendered text, a slice of `outerHTML`, and the rectangle
with the viewport it was measured in.

That descriptor is the whole trick: *this button is too wide* is a complaint
about pixels until it arrives with the test id, the route and the measurements
next to it.

## Configuration

| variable | default | what it does |
|---|---|---|
| `APP_URL` | the usual dev ports on `localhost` and `127.0.0.1` — 3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080 | Comma-separated origins the helper accepts a batch from. |
| `LIVE_PORT` | `4488` | The helper's own port. Two projects at once need a second one. |
| `LIVE_STATE_DIR` | a temp directory keyed by the project path | Where token, pid, log and batches live. |

The helper answers `127.0.0.1` only, every request carries a token from the
bookmarklet, and a batch is refused unless the browser's `Origin` is one of the
allowed ones — which is what keeps another open tab from making Claude edit your
code.

## Running it by hand

The skill drives these; they work from a terminal too, from the project root:

```bash
node skills/point-and-tell/live.mjs start     # boot, print the bookmarklet
node skills/point-and-tell/live.mjs status    # helper, project, batches
node skills/point-and-tell/live.mjs wait      # block until Go, print the batch
node skills/point-and-tell/live.mjs report --text "what was done"
node skills/point-and-tell/live.mjs stop
node skills/point-and-tell/live.mjs selftest  # headless end-to-end, needs Playwright
```
