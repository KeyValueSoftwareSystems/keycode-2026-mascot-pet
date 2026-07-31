// @ts-check
/**
 * Preload for the toast window. One channel, one direction.
 *
 * A toast has nothing to report back, so this is deliberately smaller than the pet's bridge.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('keycodeToast', {
  /** @param {(frame: unknown) => void} callback */
  onToast(callback) {
    ipcRenderer.on('keycode-pet:toast', (_event, frame) => callback(frame))
  },
})
