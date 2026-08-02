# Installing Keycode Pet

Download the file for your machine from the
[latest release](https://github.com/doylefermi-kv/keycode-2026-mascot-pet/releases/latest).

> **This app is not code-signed.** There is no Apple Developer certificate and no Windows
> code-signing certificate behind it, so **both operating systems will warn you the first time you
> open it.** That is expected and is described below. It is not a sign that something is wrong with
> the download — it means nobody has paid a certificate authority to vouch for it.

---

## macOS

Take the `.dmg` for your chip:

| Your Mac | File |
|---|---|
| Apple Silicon (M1 and later) | `Keycode Pet-<version>-mac-arm64.dmg` |
| Intel | `Keycode Pet-<version>-mac-x64.dmg` |

Not sure? Apple menu → About This Mac. "Apple M…" means arm64.

1. Open the `.dmg` and drag **Keycode Pet** into **Applications**.
2. **Do not double-click it yet.** Instead, open Applications, **right-click** (or Control-click)
   Keycode Pet and choose **Open**. Confirm at the prompt.
3. The pet appears at the bottom of your screen. A tray icon gives you the menu; so does right-clicking
   the pet itself.

You only do the right-click step **once**. After that it opens normally.

### If you double-clicked first

You will see:

> **"Keycode Pet" Not Opened** — Apple could not verify "Keycode Pet" is free of malware that may harm
> your Mac or compromise your privacy.

Click **Done** — *not* "Move to Bin" — and then either:

- right-click the app → **Open**, as above; or
- **System Settings › Privacy & Security**, scroll to the message about Keycode Pet, and click
  **Open Anyway**.

### Why

macOS quarantines anything downloaded from the internet and refuses to run it unless it is signed by a
registered Apple developer *and* notarized by Apple. This app is ad-hoc signed, which is what triggers
the dialog. Nothing about the app changes when you approve it — you are telling macOS that you trust
this particular download.

---

## Windows

Take `Keycode Pet Setup <version>.exe` and run it.

SmartScreen will say **"Windows protected your PC"** or that the publisher is unrecognised. Click
**More info**, then **Run anyway**.

Same reason as macOS: no code-signing certificate, so Windows has no publisher name to show you.

---

## Linux

| File | How |
|---|---|
| `.AppImage` | `chmod +x 'Keycode Pet-<version>.AppImage'` then run it. Nothing to install. |
| `.deb` | `sudo apt install ./keycode-pet_<version>_amd64.deb` |
| `.rpm` | `sudo dnf install ./keycode-pet-<version>.x86_64.rpm` |
| `.tar.gz` | Extract and run the binary inside. |

**Wayland:** the app forces XWayland deliberately. Native Wayland forbids an application from
positioning its own window, which breaks the one thing this app does. If you would rather use native
Wayland and accept a pet that cannot move, launch it with `KEYCODE_PET_OZONE=native`.

**If right-clicking the pet does nothing** — some Wayland compositors swallow it. Use the tray icon
instead; it has exactly the same menu.

---

## First run

- The pet starts at the bottom of your primary display and wanders.
- **Drag it anywhere.** Drop it mid-screen and it stays there; drop it near the bottom and it re-locks
  to the floor. "Reset position" in the menu brings it home.
- **Right-click** the pet (or use the tray icon) for size, movement, and reminder intervals.
- Water and stretch reminders are on by default, at 45 and 60 minutes.

## Uninstalling

| | |
|---|---|
| macOS | Delete `Keycode Pet.app` from Applications. Settings live in `~/Library/Application Support/Keycode Pet` |
| Windows | Settings → Apps → Keycode Pet → Uninstall |
| Linux | `sudo apt remove keycode-pet` (or delete the AppImage). Settings live in `~/.config/Keycode Pet` |

## Privacy

The app makes **one** network request: it fetches a small JSON file so the team can broadcast a
message to everyone. It sends no analytics, no identifiers and no usage data, and it has no accounts.

There is a **Report a problem…** menu item. It copies a filled-in report to your clipboard and opens
the log file so you can attach it — nothing is uploaded unless you do it yourself.
