# Security

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting:

**[Report a vulnerability →](https://github.com/KeyValueSoftwareSystems/keycode-2026-mascot-pet/security/advisories/new)**

This is an internal tool maintained on a best-effort basis, so expect a reply in days rather than hours.

## What the attack surface actually is

Worth stating plainly, because it is smaller than "an Electron app" suggests:

- **The app makes exactly one network request** — a `GET` for the broadcast manifest. It has no server,
  no accounts, no telemetry, and it never opens a socket.
- **The manifest is treated as hostile.** HTTPS only; redirects followed manually with the scheme
  re-checked at every hop (max 3); a 64KB cap enforced *while streaming*; a strict envelope with
  per-entry parsing; text sanitised of control characters, bidi overrides and zero-width characters,
  then clamped to 200 characters and rendered with `textContent` — never as HTML.
- **The renderer is sandboxed**, has `contextIsolation`, no Node integration, and a CSP with
  `connect-src 'none'`. A test greps it for timers, `fetch`, `innerHTML`, `eval` and any string that
  looks like a URL, so it cannot acquire them quietly.
- **`shell.openExternal` has exactly one call site**, and it re-validates the URL at the moment of use
  even though the schema already validated it at parse time.
- **Runtime dependencies: `zod`.** That is the entire list, and a test asserts it.

The realistic threats are therefore: whoever can write to the manifest can put text (not markup) in
front of every install, and whoever can publish a GitHub Release can put a binary in front of anyone who
downloads it. Both are repository-write problems rather than application ones.

## Known, accepted weaknesses

- **macOS builds are Developer ID signed and notarized.** Gatekeeper trusts the GitHub Release `.dmg`.
  Windows builds are still unsigned (no Authenticode certificate), so SmartScreen may warn once.
  `SHA256SUMS-*.txt` on each Release remains a useful integrity check for every platform.
- **The manifest is world-readable.** Anything published to it is public.
