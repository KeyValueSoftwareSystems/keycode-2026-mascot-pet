import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * The seam, enforced.
 *
 * "Main owns truth; the renderer is a dumb view" is a rule that only survives contact with a
 * deadline if something checks it. Behaviour creeps into a renderer one convenient `setTimeout` at
 * a time, and once it is there it can no longer be unit-tested and now lives in two processes.
 *
 * This also implements the anti-proof greps from docs/PROMPT.md §2 — with the corrections that
 * the brief's own commands needed: `\b` anchors (its `-i lease` matched "p**lease**" and `lan-`
 * matched "p**lan-**") and an exclusion for generated CSS, which lives in the same directory as
 * the hand-written CSS it was checking.
 */

const REPO = resolve(import.meta.dirname, '..', '..')
const RENDERER_DIR = resolve(REPO, 'apps/desktop/src/renderer')
const SRC_DIR = resolve(REPO, 'apps/desktop/src')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walk(dir: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, predicate))
    else if (predicate(entry.name)) out.push(full)
  }
  return out
}

const rendererTs = walk(RENDERER_DIR, (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))

describe('renderer discipline', () => {
  it('has renderer source to check', () => {
    expect(rendererTs.length).toBeGreaterThan(0)
  })

  it('stays small enough to read in one sitting', () => {
    for (const file of rendererTs) {
      const lines = stripComments(read(file))
        .split('\n')
        .filter((l) => l.trim().length > 0)
      expect(lines.length, `${file} has ${lines.length} code lines`).toBeLessThan(150)
    }
  })

  it('owns no timers, no network, and no dynamic code', () => {
    // Each of these would be behaviour or a capability the renderer must not have. Timers mean it
    // is deciding *when* something happens; fetch means it is talking to the world; eval means the
    // CSP is the only thing standing between remote text and execution.
    const forbidden = [
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\brequestAnimationFrame\b/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\beval\s*\(/,
      /new\s+Function\b/,
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
    ]
    for (const file of rendererTs) {
      const code = stripComments(read(file))
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false)
      }
    }
  })

  it('never imports electron', () => {
    // A sandboxed renderer cannot reach Electron anyway; importing it would mean the seam has been
    // routed around rather than used.
    for (const file of rendererTs) {
      expect(stripComments(read(file))).not.toMatch(/from\s+['"]electron['"]/)
    }
  })

  it('renders untrusted text only through textContent', () => {
    const pet = read(join(RENDERER_DIR, 'pet.ts'))
    expect(pet).toContain('textContent')
  })

  it('never holds a callout URL', () => {
    // The renderer asks main to open "the current callout's link" and never learns the string. A
    // renderer that cannot name a URL cannot be talked into opening a bad one.
    for (const file of rendererTs) {
      const code = stripComments(read(file))
      expect(code).not.toMatch(/shell\.openExternal/)
      expect(code).not.toMatch(/https?:\/\//)
    }
  })
})

describe('hand-written CSS carries no generated geometry', () => {
  it('contains no steps() or frame-sized pixel offsets', () => {
    // Animation geometry has exactly one source. The brief's own grep for this matched the
    // generated file sitting in the same directory; this excludes it by name instead.
    const handWritten = walk(
      RENDERER_DIR,
      (n) => n.endsWith('.css') && !n.includes('.generated.'),
    )
    expect(handWritten.length).toBeGreaterThan(0)

    for (const file of handWritten) {
      const css = read(file)
      expect(css, `${file} declares animation steps`).not.toMatch(/steps\(\s*\d/)
      // 192 and 208 are the sprite cell dimensions; seeing them hand-written means geometry has
      // been duplicated out of spritesheet.json.
      expect(css, `${file} hardcodes the frame width`).not.toMatch(/\b192px\b/)
      expect(css, `${file} hardcodes the frame height`).not.toMatch(/\b208px\b/)
    }
  })

  it('anchors the bubble to the character through the published custom properties', () => {
    // The bubble is a speech bubble, so its position is the character's, not the window's. The two
    // halves of that live in different files — the renderer publishes the anchor, the CSS consumes
    // it — and either one being dropped leaves a bubble that quietly floats back to a corner.
    const pet = read(join(RENDERER_DIR, 'pet.ts'))
    expect(pet).toContain('--body-cx')
    expect(pet).toContain('--body-top')
    expect(pet).toContain('headTopByState')

    const css = read(join(RENDERER_DIR, 'pet.css'))
    expect(css).toMatch(/var\(--body-cx/)
    expect(css).toMatch(/var\(--body-top/)
  })

  it('scales the sprite by transform, and publishes the scale', () => {
    // The generated keyframes step `background-position` in absolute pixels off the unscaled sheet.
    // Resizing the element or its background-size to change the pet's size would invalidate every one
    // of them, so the scale must stay a transform.
    const css = read(join(RENDERER_DIR, 'pet.css'))
    expect(css).toMatch(/transform:\s*scale\(var\(--pet-scale/)
    expect(read(join(RENDERER_DIR, 'pet.ts'))).toContain('--pet-scale')
  })
})

describe('anti-proofs from docs/PROMPT.md §2', () => {
  const sources = walk(
    SRC_DIR,
    (n) => (n.endsWith('.ts') || n.endsWith('.cjs')) && !n.includes('.generated.'),
  )

  it('contains no plugin system, marketplace, catalog, LAN mode or lease manager', () => {
    // Word-anchored: the brief's unanchored `-i lease` matched "please" and `lan-` matched "plan-".
    const forbidden = [/\bplugins?\b/i, /\bmarketplace\b/i, /\bcatalog\b/i, /\blan-/i, /\bleases?\b/i]
    for (const file of sources) {
      const code = stripComments(read(file))
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false)
      }
    }
  })

  it('ships no UI framework', () => {
    const pkg = JSON.parse(read(resolve(REPO, 'apps/desktop/package.json'))) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const banned of ['react', 'react-dom', 'vue', 'svelte', 'tailwindcss', 'electron-updater']) {
      expect(Object.keys(all)).not.toContain(banned)
    }
  })

  it('keeps runtime dependencies to zod alone', () => {
    const pkg = JSON.parse(read(resolve(REPO, 'apps/desktop/package.json'))) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod'])
  })

  it('uses no canvas or WebGL sprite rendering', () => {
    for (const file of sources) {
      const code = stripComments(read(file))
      expect(code).not.toMatch(/getContext\(\s*['"]2d['"]/)
      expect(code).not.toMatch(/getContext\(\s*['"]webgl/)
    }
  })
})
