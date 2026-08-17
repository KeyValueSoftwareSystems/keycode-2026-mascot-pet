# Installing Argus

Download the file for your machine from the
[latest release](https://github.com/KeyValueSoftwareSystems/keycode-2026-mascot-pet/releases/latest)
or the [download page](https://keyvaluesoftwaresystems.github.io/keycode-2026-mascot-pet/), which
picks the right file for the device you are on.

**macOS** builds are signed with a Developer ID and notarized by Apple — open the `.dmg` and run the
app normally. **Windows** has no Authenticode certificate yet, so SmartScreen may warn once (see
below).

---

## macOS

Take the `.dmg` for your chip:

| Your Mac | File |
|---|---|
| Apple Silicon (M1 and later) | `Argus-<version>-mac-arm64.dmg` |
| Intel | `Argus-<version>-mac-x64.dmg` |

Not sure? Apple menu → About This Mac. "Apple M…" means arm64.

1. Open the `.dmg` and drag **Argus** into **Applications**.
2. Open it from Applications (double-click is fine).
3. The pet appears at the bottom of your screen. A tray icon gives you the menu; so does right-clicking
   the pet itself.

---

## Windows

Take `Argus-<version>-win-x64.exe` and run it.

SmartScreen may say **"Windows protected your PC"** or that the publisher is unrecognised. Click
**More info**, then **Run anyway**. That is expected until an Authenticode certificate is added —
it is not a sign the download is corrupt.

---

## Linux

| File | How |
|---|---|
| `.AppImage` | `chmod +x 'Argus-<version>-linux-x86_64.AppImage'` then run it. Nothing to install. |
| `.deb` | `sudo apt install ./Argus-<version>-linux-x64.deb` |
| `.rpm` | `sudo dnf install ./Argus-<version>-linux-x64.rpm` |
| `.tar.gz` | Extract and run the binary inside. |

**Wayland:** the app forces XWayland deliberately. Native Wayland forbids an application from
positioning its own window, which breaks the one thing this app does. If you would rather use native
Wayland and accept a pet that cannot move, launch it with `KEYCODE_PET_OZONE=native`.

**If right-clicking the pet does nothing** — some Wayland compositors swallow it. Use the tray icon
instead; it has exactly the same menu.

**Emoji in a message may show as a box.** A known bug, not a corrupt download: the app bundles a colour
emoji font for Linux and it is not being applied. Installing your distribution's own emoji font fixes
it — `sudo apt install fonts-noto-color-emoji` on Debian, Ubuntu and Mint. The rest of the message is
unaffected.

---

## First run

- The pet starts at the bottom of your primary display and wanders.
- **Drag it anywhere.** Drop it mid-screen and it stays there; drop it near the bottom and it re-locks
  to the floor. Take it to the very top and its speech bubble moves underneath it. "Reset position" in
  the menu brings it home.
- **Right-click** the pet (or use the tray icon) for size, movement, always-on-top, and reminder
  intervals. The pet starts small.
- Anything marked **(default)** in the menu came from your team's shared settings rather than from you.
  Pick it explicitly and it becomes yours, and no later team change will move it.
- **Always on top** is on to begin with. Turn it off and the pet sits behind your windows; it still
  comes forward for as long as it has a message on screen, then drops back.
- Water, stretch, coffee and lunch reminders are on by default. A reminder stays until you tap ✓ or
  Snooze (one minute). Your team sets the starting water/stretch intervals; you can change either from
  the menu — your choice then sticks.

## Uninstalling

| | |
|---|---|
| macOS | Delete `Argus.app` from Applications. Settings live in `~/Library/Application Support/Argus` (older installs may still have `~/Library/Application Support/Keycode Pet`, which is copied forward on first launch) |
| Windows | Settings → Apps → Argus → Uninstall |
| Linux | `sudo apt remove keycode-pet` (or delete the AppImage). Settings live in `~/.config/Argus` |

## Privacy

The app makes **one** network request: it fetches a small JSON file so the team can broadcast a
message to everyone. It sends no analytics, no identifiers and no usage data, and it has no accounts.

There is a **Report a problem…** menu item. It copies a filled-in report to your clipboard and opens
the log file so you can attach it — nothing is uploaded unless you do it yourself.
