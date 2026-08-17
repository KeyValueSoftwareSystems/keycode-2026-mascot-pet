// @ts-check
/**
 * Preload bridge for the pet window. CommonJS, dependency-free, deliberately dumb.
 *
 * Under `sandbox: true` a preload cannot `require` anything outside Electron's allowlist — so no
 * zod here. Validation happens in main before sending and in the renderer bundle after
 * receiving; this file only moves messages.
 *
 * Its one piece of intelligence is edge-deduping `pointerOverPet`: mousemove fires continuously,
 * and main only cares about transitions. Without this a hover produces an IPC storm.
 *
 * The exposed surface is small and enumerated. There is no generic `ipcRenderer` passthrough,
 * so the page cannot reach a channel this file does not name.
 */

const { contextBridge, ipcRenderer } = require('electron')

const IPC = {
  frame: 'keycode-pet:frame',
  pointerProbe: 'keycode-pet:pointer-probe',
  pointerOverPet: 'keycode-pet:pointer-over-pet',
  rendererReady: 'keycode-pet:renderer-ready',
  contextMenu: 'keycode-pet:context-menu',
  dragStart: 'keycode-pet:drag-start',
  dragEnd: 'keycode-pet:drag-end',
  bubbleClicked: 'keycode-pet:bubble-clicked',
  bubbleAction: 'keycode-pet:bubble-action',
  quickAction: 'keycode-pet:quick-action',
}

/** Last reported hover state, so only transitions cross the process boundary. */
let lastPointerOverPet = null

contextBridge.exposeInMainWorld('keycodePet', {
  /** @param {(frame: unknown) => void} callback */
  onFrame(callback) {
    ipcRenderer.on(IPC.frame, (_event, frame) => callback(frame))
  },

  /**
   * Main asking for a hit-test at coordinates it computed itself.
   *
   * This exists because on macOS and Windows the compositor can silently stop delivering
   * forwarded mouse events, at which point the renderer will never see another mousemove and
   * the pet becomes ungrabbable. Main's cursor probe still works, so it pushes the coordinates.
   *
   * @param {(probe: unknown) => void} callback
   */
  onPointerProbe(callback) {
    ipcRenderer.on(IPC.pointerProbe, (_event, probe) => callback(probe))
  },

  /** @param {boolean} over */
  reportPointerOverPet(over) {
    const next = Boolean(over)
    if (next === lastPointerOverPet) return
    lastPointerOverPet = next
    ipcRenderer.send(IPC.pointerOverPet, next)
  },

  /** The spritesheet has decoded and the first frame is painted. */
  reportReady() {
    ipcRenderer.send(IPC.rendererReady)
  },

  requestContextMenu() {
    ipcRenderer.send(IPC.contextMenu)
  },

  beginDrag() {
    ipcRenderer.send(IPC.dragStart)
  },

  endDrag() {
    ipcRenderer.send(IPC.dragEnd)
  },

  /** Open the current callout's link. Main holds and re-validates the URL; the renderer never sees it. */
  bubbleClicked() {
    ipcRenderer.send(IPC.bubbleClicked)
  },

  /** @param {string} action */
  bubbleAction(action) {
    ipcRenderer.send(IPC.bubbleAction, action)
  },

  /** @param {string} action */
  quickAction(action) {
    ipcRenderer.send(IPC.quickAction, action)
  },
})
