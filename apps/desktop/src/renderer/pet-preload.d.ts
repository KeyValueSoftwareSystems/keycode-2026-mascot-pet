/**
 * The preload bridge, as the renderer sees it.
 *
 * Mirrors `src/preload/pet-preload.cjs`. Kept narrow on purpose: there is no generic
 * `ipcRenderer` passthrough, so the page cannot reach a channel the preload does not name.
 *
 * The continuous channel is a single boolean (`reportPointerOverPet`). Everything else is a
 * discrete user-intent or lifecycle signal with no payload richer than coordinates — worth
 * stating because the method count on its own could look like the seam has drifted.
 */

export interface KeycodePetBridge {
  onFrame(callback: (frame: unknown) => void): void
  onPointerProbe(callback: (probe: unknown) => void): void
  reportPointerOverPet(over: boolean): void
  reportReady(): void
  requestContextMenu(): void
  beginDrag(): void
  endDrag(): void
  openCalloutUrl(): void
}

declare global {
  interface Window {
    readonly keycodePet: KeycodePetBridge
  }
}
