# Changelog

Every release is on the **[Releases page](https://github.com/doylefermi-kv/keycode-2026-mascot-pet/releases)**,
with its artifacts and generated notes. This file records only the shape of the history, so nothing has
to be kept in sync by hand.

`git tag -n1` is the fastest changelog: tags are annotated, one line each.

## Milestones

`v0.0.0`–`v0.8.0` are the nine build milestones, in build order. `v1.0.0` marks all of them green.

> `v0.8.0` is an *ancestor* of `v0.7.0`: the update check was built before packaging, because packaging
> last means packaging everything. The tags name milestones, not a release sequence.

## Releases

From `v1.1.0` onward these are real releases:

| | |
|---|---|
| `v1.1.0` | Speech-bubble callouts, a real broadcast host, a truthful app version |
| `v1.2.0` | Free placement — drag the pet anywhere and it stays |
| `v1.3.0` | Three pet sizes |
| `v1.4.0` | Reminder intervals in the menu, team defaults from the manifest |
| `v1.5.0` | Manifest-controlled poll interval, forward-compatible `defaults` |
| `v1.6.0` | Notifications that wait to be clicked |
| `v1.6.1` | Made the effective poll interval visible in the log |
| `v1.7.0` | Public repo, GitHub Pages manifest, `pnpm notify`, CI on three OSes |
| `v1.7.1` | Release announcements from CI, 1-minute polling |
| `v1.8.0` | **Linux: the speech bubble is drawn at all.** An "Always on top" toggle. The pet reaches the top of the screen, and the bubble flips below it |

Why each decision was made — including the ones that were wrong first — is in
[DECISIONS.md](DECISIONS.md).
