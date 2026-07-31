/**
 * The toast bridge, as the renderer sees it. Mirrors `src/preload/toast-preload.cjs`.
 *
 * One channel, one direction: a toast has nothing to report back.
 */

export interface ToastFrame {
  text: string
  tone: 'info' | 'success' | 'warning' | 'error'
  durationMs: number
}

export interface KeycodeToastBridge {
  onToast(callback: (frame: unknown) => void): void
}

declare global {
  interface Window {
    readonly keycodeToast: KeycodeToastBridge
  }
}
