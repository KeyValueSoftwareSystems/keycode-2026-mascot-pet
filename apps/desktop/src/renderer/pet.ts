/**
 * The pet renderer. A dumb view, and it must stay that way.
 *
 * Allowed: set attributes, set textContent, do hit-test arithmetic, report one boolean.
 * Forbidden: timers, fetch, state machines, URLs, and any `if` about what the pet should do.
 *
 * `tests/renderer/discipline.spec.ts` greps this file for violations, because "keep behaviour
 * out of the renderer" only survives contact with a deadline if something checks.
 */

import { ALPHA_MASK, isOpaqueAt } from '../sprite/alpha-mask.js'
import type { PetFrame, PointerProbe } from '../pet-frame.js'

/** Fail loudly at load rather than producing a pet that silently never updates. */
function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`pet.html is missing ${selector}`)
  return element
}

const sprite = required<HTMLDivElement>('#sprite')
const bubble = required<HTMLDivElement>('#bubble')
const bubbleText = required<HTMLSpanElement>('#bubble-text')
const root = document.documentElement

/** Where the sprite cell sits in the window. Main tells us; we never assume. */
let spriteOrigin = { x: 0, y: 0 }
/** Rendered scale, needed to map a screen-space hit back into unscaled mask coordinates. */
let petScale = 1

function applyFrame(frame: PetFrame): void {
  spriteOrigin = frame.sprite
  petScale = frame.scale

  // Set on the root, not on #sprite. Custom properties inherit *downwards*, and #zzz is a sibling
  // of #sprite — setting them on the sprite left the sleep overlay falling back to 0px and drifting
  // from the top-left corner of the window instead of from the pet's head.
  root.style.setProperty('--sprite-x', `${frame.sprite.x}px`)
  root.style.setProperty('--sprite-y', `${frame.sprite.y}px`)
  // Unitless: the stylesheet both scales the sprite by it and multiplies cell-space offsets with it.
  root.style.setProperty('--pet-scale', String(frame.scale))

  // Where the *character* is, as opposed to where its cell is. The cell is 44% empty space
  // horizontally and has transparent padding above the hair, so anchoring the bubble to the cell
  // leaves it floating a long way off the head. These come from the generated mask so the offsets
  // stay out of the hand-written CSS, which is asserted to contain no sheet geometry.
  const bbox = ALPHA_MASK.bbox
  const headTop = ALPHA_MASK.headTopByState[frame.animation] ?? bbox.y
  // Cell-space offsets scaled here rather than in CSS, so the bubble tracks the head at every size.
  root.style.setProperty('--body-cx', `${frame.sprite.x + (bbox.x + bbox.width / 2) * frame.scale}px`)
  root.style.setProperty('--body-top', `${frame.sprite.y + headTop * frame.scale}px`)

  // Setting data-state and data-nonce is the whole animation mechanism: the generated CSS keys
  // its keyframes off this pair, and a changed nonce is what makes the same state replay.
  sprite.dataset.state = frame.animation
  sprite.dataset.nonce = String(frame.animationNonce)
  sprite.dataset.facing = frame.facing

  root.dataset.overlay = frame.overlay

  if (frame.bubble) {
    // textContent, never innerHTML. Manifest text is remote input rendered into a window that
    // floats above everything on the user's machine.
    bubbleText.textContent = frame.bubble.text
    bubble.dataset.tone = frame.bubble.tone
    bubble.dataset.pinned = String(frame.bubble.pinned)
    bubble.dataset.clickable = String(frame.bubble.clickable)
    bubble.hidden = false
  } else {
    bubbleText.textContent = ''
    bubble.hidden = true
  }
}

/**
 * Is this window-local point on the pet?
 *
 * The visible character fills only ~21% of its cell and the transparent margin is mostly
 * horizontal, so this is mask geometry rather than a bounding box. A visible bubble counts too.
 */
function isOverPet(clientX: number, clientY: number): boolean {
  if (!bubble.hidden) {
    const box = bubble.getBoundingClientRect()
    if (
      clientX >= box.left &&
      clientX <= box.right &&
      clientY >= box.top &&
      clientY <= box.bottom
    ) {
      return true
    }
  }
  return isOpaqueAt(
    ALPHA_MASK,
    clientX - spriteOrigin.x,
    clientY - spriteOrigin.y,
    undefined,
    petScale,
  )
}

function report(clientX: number, clientY: number): void {
  window.keycodePet.reportPointerOverPet(isOverPet(clientX, clientY))
}

window.keycodePet.onFrame((frame) => {
  applyFrame(frame as PetFrame)
})

window.keycodePet.onPointerProbe((probe) => {
  const { clientX, clientY, inside } = probe as PointerProbe
  window.keycodePet.reportPointerOverPet(inside && isOverPet(clientX, clientY))
})

document.addEventListener(
  'mousemove',
  (event) => {
    report(event.clientX, event.clientY)
  },
  { passive: true },
)

document.addEventListener('mouseleave', () => {
  window.keycodePet.reportPointerOverPet(false)
})

document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.keycodePet.requestContextMenu()
})

// A click on a linked bubble opens its link; anything else on the pet starts a drag. Routed by
// DOM event targeting rather than by comparing rectangles, so there is no geometry to get wrong
// and no behavioural branch in this file.
bubble.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || bubble.dataset.clickable !== 'true') return
  event.stopPropagation()
  window.keycodePet.openCalloutUrl()
})

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (isOverPet(event.clientX, event.clientY)) window.keycodePet.beginDrag()
})

document.addEventListener('pointerup', () => {
  window.keycodePet.endDrag()
})

/**
 * Report readiness only once the spritesheet bitmap has decoded.
 *
 * `ready-to-show` fires before the image is available, so a capture taken then can catch an
 * empty div. This is the difference between the harness screenshotting the pet and
 * screenshotting nothing.
 */
const sheetUrl = getComputedStyle(sprite)
  .backgroundImage.replace(/^url\(["']?/, '')
  .replace(/["']?\)$/, '')

const probe = new Image()
probe.src = sheetUrl
probe
  .decode()
  .catch(() => {
    // Report anyway: a missing sheet is a loud visual failure the harness will catch, and
    // hanging here would look like a launch failure instead.
  })
  .finally(() => {
    window.keycodePet.reportReady()
  })
