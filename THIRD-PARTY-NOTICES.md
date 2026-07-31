# Third-party notices

This application redistributes the following third-party material. Internal-only distribution
removes code-signing and attestation obligations; it does **not** remove these attribution and
licence obligations.

---

## openpets

Portions of the main-process window, mouse-forwarding, always-on-top, tray, bubble-arbitration and
HTTPS-polling logic are adapted from **openpets** by alvinunreal.

- Source: https://github.com/alvinunreal/openpets
- Licence: MIT

Files in this repository that derive from openpets:

| This repository | Derived from |
|---|---|
| `apps/desktop/src/main/pet-window.ts` | `apps/desktop/src/pet-window.ts` |
| `apps/desktop/src/main/mouse-forwarding.ts` | `apps/desktop/src/mouse-forwarding.ts` |
| `apps/desktop/src/main/always-on-top.ts` | `apps/desktop/src/pet-window.ts` (`applyPetAlwaysOnTop`) |
| `apps/desktop/src/main/tray.ts` | `apps/desktop/src/tray.ts` |
| `apps/desktop/src/callouts/callout-arbiter.ts` | `apps/desktop/src/plugin-bubble-arbiter.ts` |
| `apps/desktop/src/main/toast.ts`, `toast-layout.ts` | `apps/desktop/src/plugin-toast.ts` |
| `apps/desktop/src/main/display-manager.ts` | `apps/desktop/src/display.ts` |
| `apps/desktop/src/broadcast/http-capped.ts` | `apps/desktop/src/update-checker.ts` |
| `apps/desktop/src/updates/version-compare.ts` | `apps/desktop/src/update-version.ts` |

**No sprite art from openpets is used.** The pet art in `pet/` is separate (see below).

```
MIT License

Copyright (c) 2024 alvinunreal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Noto Color Emoji (COLRv1)

Bundled at `apps/desktop/assets/fonts/NotoColorEmoji-COLRv1.ttf` as a Linux fallback. macOS ships
Apple Color Emoji and Windows ships Segoe UI Emoji, both of which come first in the font stack, so
this file is only consulted where neither exists.

- Source: https://github.com/googlefonts/noto-emoji (`fonts/Noto-COLRv1.ttf`)
- Font software licence: **SIL Open Font License 1.1**
- Emoji artwork licence: **Apache License 2.0**

The COLRv1 build is bundled rather than the CBDT build because it is roughly half the size
(5.0 MB versus ~10 MB) and Chromium has supported COLRv1 since version 98.

Full licence texts: https://openfontlicense.org/open-font-license-official-text/ and
https://www.apache.org/licenses/LICENSE-2.0

---

## Pet art — `pixel-coder`

`pet/` contains a placeholder character supplied with this project. It is not openpets art and is
not covered by the licences above. It is a stand-in for a Keycode-branded spritesheet; see
`docs/ASSETS.md` for how to replace it.
