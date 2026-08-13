# Installing Keycode Pet

Download the file for your machine from the
[latest release](https://github.com/KeyValueSoftwareSystems/keycode-2026-mascot-pet/releases/latest).

**macOS** builds are signed with a Developer ID and notarized by Apple — open the `.dmg` and run the
app normally. **Windows** has no Authenticode certificate yet, so SmartScreen may warn once (see
below).

---

## macOS

Take the `.dmg` for your chip:

| Your Mac | File |
|---|---|
| Apple Silicon (M1 and later) | `Keycode Pet-<version>-mac-arm64.dmg` |
| Intel | `Keycode Pet-<version>-mac-x64.dmg` |

Not sure? Apple menu → About This Mac. "Apple M…" means arm64.

1. Open the `.dmg` and drag **Keycode Pet** into **Applications**.
2. Open it from Applications (double-click is fine).
3. The pet appears at the bottom of your screen. A tray icon gives you the menu; so does right-clicking
   the pet itself.

---

## Windows

Take `Keycode Pet Setup <version>.exe` and run it.

SmartScreen may say **"Windows protected your PC"** or that the publisher is unrecognised. Click
**More info**, then **Run anyway**. That is expected until an Authenticode certificate is added —
it is not a sign the download is corrupt.

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
- Water and stretch reminders are on by default. Your team sets the starting intervals; out of the box
  that is every 5 and 15 minutes, and you can change either from the menu — your choice then sticks.

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
