# Broadcast

One static JSON file, polled over HTTPS, reaching every installed client. No push service, no
sockets, no per-user registration, no backend — which is why it can be hosted on anything that
serves a file.

> **Everything you put in this file is readable by every install, and on most hosting choices by
> anyone who finds the URL.** No customer names, no unannounced dates, no internal links you would
> not put in a public changelog.

## Where it lives

**Not decided yet.** The default is the local dev server, because no host has been chosen:

```
http://127.0.0.1:8787/manifest.json
```

Switching to a real host is one environment variable — no rebuild:

```bash
KEYCODE_PET_MANIFEST_URL=https://your-host/keycode-pet/manifest.json
```

`manifest/manifest.json` in this repo is the reviewed source of truth. Whatever host is chosen
should serve that file's contents.

Candidate hosts, with the trade-offs that actually matter:

| Host | Works today | Notes |
|---|---|---|
| A **public** GitHub repo, raw URL | yes | Serves 200 directly with a strong ETag and ~5min CDN TTL, which lines up with the poll interval. **A private repo's raw URL 404s without a short-lived token, so it cannot be a baked-in default.** |
| GitHub Pages | yes | Lets a custom domain land later |
| Cloudflare R2 / S3 + CloudFront | yes | Real cache-control, the right end state for an internal tool |
| Public Gist raw | yes | Zero setup, but 302s — which the poller handles, having been built to re-validate every hop |

A CDN TTL means "within one poll interval" can in the worst case be closer to two. That is a
property of the host, not a bug in the client.

## Publishing a message

Add an entry to `notifications` and publish the file.

```jsonc
{
  "version": 1,
  "notifications": [
    {
      "id": "keycode-2026-kickoff",     // REQUIRED. The dedupe key — see below.
      "text": "Keycode is on fire 🔥 Submissions close Friday!",
      "tone": "info",                    // info | success | warning | error
      "priority": "normal",              // low | normal | high | urgent
      "animation": "waving",             // any state in pet/spritesheet.json
      "durationMs": 8000,
      "startsAt": "2026-08-01T09:00:00Z",
      "expiresAt": "2026-08-05T18:00:00Z",
      "url": "https://example.com/announcements/kickoff"
    }
  ],
  "release": {
    "latestVersion": "0.8.0",
    "notesUrl": "https://example.com/releases",
    "mandatory": false
  }
}
```

### `id` is a persistence key

Each id is shown **exactly once per install, ever**. It is written to the client's settings file the
moment its callout is submitted, with a forced flush, so a crash immediately afterwards cannot
re-show it.

Consequences:

- **Editing the `text` of an existing id changes nothing** for anyone who already saw it. To say
  something again, use a new id.
- Ids are never trimmed or normalised — `kickoff` and `kickoff ` would be different keys, so the
  charset is restricted to prevent the ambiguity arising at all.
- Clients remember the most recent 500 ids, FIFO. A message older than 500 announcements *could*
  reappear on a long-lived install; in practice that is years away.

## Every limit, with its number

The manifest is remote input rendered into a window that floats above everything on someone's
machine, so it is treated as hostile throughout.

| Field / aspect | Rule |
|---|---|
| Scheme | **HTTPS only.** Loopback `http://` is allowed only when `KEYCODE_PET_ALLOW_INSECURE_MANIFEST=1` **and** the build is unpackaged. `app.isPackaged` is not env-overridable, so a shipped build cannot be talked into it |
| Redirects | Followed **manually**, max **3** hops, with the scheme re-validated at every hop. A `302` from https to http is refused |
| Timeout | 6s |
| Body cap | **64 KB**, enforced while streaming — the body is abandoned mid-read, never buffered and then measured |
| Envelope | `version` must be `1`; unknown top-level fields reject the whole file |
| `notifications` | First **32** considered. A malformed *entry* is dropped on its own and logged; it never invalidates the others |
| Duplicate ids | The second one in a single file is dropped |
| `id` | 1–128 chars, `[A-Za-z0-9._-]` only |
| `text` | Sanitised then clamped to **200** chars with an ellipsis. Control characters, bidi overrides/isolates and zero-width characters are stripped; emoji ZWJ and variation selectors are kept. Rendered with `textContent`, never as HTML |
| `tone` | One of `info`/`success`/`warning`/`error`, default `info` |
| `priority` | One of `low`/`normal`/`high`/`urgent`, default `normal` |
| `animation` | Must be a state the current art provides; anything else falls back to `waving` |
| `durationMs` | Clamped to **2000–30000**; absent means 6000 |
| `startsAt` / `expiresAt` | ISO-8601 **with an explicit offset** (`Z` or `±HH:MM`). Without one the entry is dropped, because a window that shifts by the reader's timezone is not a schedule. `startsAt` must precede `expiresAt` |
| `url` | HTTPS only. A bad URL costs the link, not the message — the callout is simply not clickable |
| Poll | Every **5 min** with **±20%** jitter, plus once on launch. `KEYCODE_PET_POLL_MINUTES` overrides, clamped to 1–1440 |
| Concurrency | One request in flight; a timer firing during a slow response is dropped, never stacked |
| Change detection | An in-memory sha of the body. `If-None-Match` is sent as politeness, but correctness does not depend on how a given stack surfaces `304` |

### Failure is silent, by design

A 500, a timeout, a truncated body, malformed JSON, invalid UTF-8, an oversized body, a redirect
loop, a scheme downgrade, or no network at all produce **one debug log line and nothing else**. No
dialog, no bubble, no animation, no interruption. A colleague on a plane cannot tell that polling is
failing.

Verified by running all nine cases against the dev server's fault injection: in every one the pet
kept animating normally and no callout appeared.

## Testing without a host

```bash
pnpm manifest:serve                                  # serves manifest/manifest.json on :8787

KEYCODE_PET_MANIFEST_URL=http://127.0.0.1:8787/manifest.json \
KEYCODE_PET_ALLOW_INSECURE_MANIFEST=1 \
KEYCODE_PET_POLL_MINUTES=1 \
pnpm dev
```

The server re-reads the file on every request, so editing `manifest/manifest.json` is visible to a
running client on its next poll.

Fault injection, so every negative path above can actually be exercised:

```
?fault=500        HTTP 500
?fault=404        HTTP 404
?fault=slow       never responds (exercises the timeout)
?fault=truncate   declares a length, then closes mid-body
?fault=oversize   a body larger than the 64KB cap, with no content-length
?fault=badjson    valid HTTP, invalid JSON
?fault=badutf8    invalid UTF-8 bytes
?fault=redirect   302 to an http:// host (must be refused as a downgrade)
?fault=loop       302 to itself (must be refused after the hop limit)
```

To re-prove "shown exactly once", clear the client's memory between runs:

```bash
rm -rf "$HOME/Library/Application Support/Keycode Pet"
```

## Who can publish

**Not decided.** Whoever owns the chosen host owns the ability to make every installed pet speak, so
it deserves the same care as a deploy: review the change to `manifest/manifest.json` in this repo,
then publish that reviewed content.
