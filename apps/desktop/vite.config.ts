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
    // The pet renders pixel art from a spritesheet; inlining it as a data URI would bloat
    // the HTML and defeat the browser's image cache. Keep every asset a real file.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        backdrop: resolve(import.meta.dirname, 'src/renderer/backdrop.html'),
      },
    },
    target: 'chrome130',
    minify: false,
    sourcemap: true,
  },
})
