import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * Renderer bundle only. The main process is compiled by `tsc` (see tsconfig.main.json) —
 * Vite would add nothing there and would obscure the ESM/CJS boundary that the sandboxed
 * `.cjs` preload depends on.
 *
 * Output lands in `dist/renderer/`, which `paths.ts::rendererFile()` resolves against.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Flat output. The generated CSS references the spritesheet by literal relative filename
    // (`./spritesheet.png`), and copy-static places it at the root of this directory. With the
    // default `assets/` subdirectory the CSS would resolve that against `assets/` and 404 —
    // which shows up as an invisible pet, not as a build error.
    assetsDir: '.',
    // The pet renders pixel art from a spritesheet; inlining it as a data URI would bloat
    // the HTML and defeat the browser's image cache. Keep every asset a real file.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        pet: resolve(import.meta.dirname, 'src/renderer/pet.html'),
        backdrop: resolve(import.meta.dirname, 'src/renderer/backdrop.html'),
      },
    },
    target: 'chrome130',
    minify: false,
    sourcemap: true,
  },
})
