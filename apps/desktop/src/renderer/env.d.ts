/// <reference types="vite/client" />

/**
 * Renderer-side ambient types.
 *
 * The renderer is deliberately framework-free and has no Node types: it is a sandboxed
 * page whose only privileged capability arrives through the preload bridge, declared in
 * `pet-preload.d.ts` from M3 onward.
 */
export {}
