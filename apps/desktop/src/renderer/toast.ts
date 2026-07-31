/**
 * The toast renderer. A second dumb view, under the same rules as the pet renderer:
 * set attributes, set textContent, nothing else.
 */

const toast = document.querySelector<HTMLDivElement>('#toast')
const text = document.querySelector<HTMLSpanElement>('#text')

if (!toast || !text) throw new Error('toast.html is missing #toast or #text')

window.keycodeToast.onToast((frame) => {
  const { text: message, tone, durationMs } = frame as {
    text: string
    tone: string
    durationMs: number
  }

  // textContent, never innerHTML. This string may have come from the broadcast manifest.
  text.textContent = message
  document.documentElement.dataset.tone = tone
  // Set as a number-derived string, so the untrusted part of the payload never reaches CSS as text.
  toast.style.setProperty('--life', `${Math.round(durationMs)}ms`)
})
