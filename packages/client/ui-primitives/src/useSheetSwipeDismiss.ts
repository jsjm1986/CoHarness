import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Bind platform sheet dismissal to a bottom-sheet element: a downward drag
 * anywhere on the sheet tracks the finger and fades the adjacent scrim; a
 * release past the distance or velocity threshold calls `onDismiss`, and a
 * short release glides the sheet back. The drag yields to any scrolled
 * region in the touch's ancestry — a scrollable body pinned at its top does
 * not claim the pan. Active only at sheet widths (`max-width: 767px`, the
 * same boundary the sheet styles use). Listeners are native because React
 * binds touch handlers passive and the gesture needs preventDefault once
 * vertical intent is established.
 * @param sheet - element rendered as the bottom sheet.
 * @param active - whether the sheet is currently mounted and open.
 * @param onDismiss - close callback; identity may change per render.
 */
export function useSheetSwipeDismiss(
  sheet: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!active) return
    const el = sheet.current
    if (el === null
      || typeof window.matchMedia !== 'function'
      || !window.matchMedia('(max-width: 767px)').matches) return
    const scrim = el.previousElementSibling
    let drag: {
      x: number
      y: number
      t0: number
      target: EventTarget | null
      engaged: boolean
      lastDy: number
    } | null = null
    const down = (event: TouchEvent) => {
      const t = event.touches[0]
      if (t === undefined) return
      drag = { x: t.clientX, y: t.clientY, t0: performance.now(), target: event.target, engaged: false, lastDy: 0 }
    }
    const move = (event: TouchEvent) => {
      const d = drag
      const t = event.touches[0]
      if (d === null || t === undefined) return
      const dy = t.clientY - d.y
      const dx = t.clientX - d.x
      if (!d.engaged) {
        if (dy > 12 && dy > Math.abs(dx)) {
          let node = d.target instanceof Element ? d.target : null
          while (node !== null) {
            /* The sheet itself is a scroller too: a pull on a scrolled-down
               sheet scrolls it back rather than dismissing. */
            if (node.scrollHeight > node.clientHeight && node.scrollTop > 0) {
              drag = null
              return
            }
            if (node === el) break
            node = node.parentElement
          }
          d.engaged = true
          el.style.transition = 'none'
        } else if (Math.abs(dx) > 12 || dy < -12) {
          drag = null
          return
        } else {
          return
        }
      }
      d.lastDy = dy
      event.preventDefault()
      el.style.transform = `translateY(${Math.max(0, dy)}px)`
      if (scrim instanceof HTMLElement) {
        const drop = Math.max(0, 1 - dy / Math.max(1, el.offsetHeight))
        scrim.style.transition = 'none'
        scrim.style.opacity = String(drop)
      }
    }
    const finish = () => {
      const d = drag
      drag = null
      if (d === null || !d.engaged) return
      const velocity = d.lastDy / Math.max(1, performance.now() - d.t0)
      if (d.lastDy > 96 || velocity > 0.35) {
        onDismiss()
        return
      }
      /* Sheet cards animate in with a keyframe but carry no transform
         transition, so the snap-back borrows an inline one; the next drag
         re-arms 'none' before tracking again. */
      el.style.transition = 'transform var(--ds-transition-duration) var(--ds-ease-in-out)'
      el.style.transform = ''
      if (scrim instanceof HTMLElement) {
        scrim.style.transition = 'opacity var(--ds-transition-duration) var(--ds-ease-in-out)'
        scrim.style.opacity = ''
      }
    }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', finish)
    el.addEventListener('touchcancel', finish)
    return () => {
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', finish)
      el.removeEventListener('touchcancel', finish)
      el.style.transition = ''
      el.style.transform = ''
      if (scrim instanceof HTMLElement) {
        scrim.style.transition = ''
        scrim.style.opacity = ''
      }
    }
    // onDismiss identity churns every render in callers; read through a
    // ref-like wrapper at the call site so the listener binds once per open.
  }, [sheet, active, onDismiss])
}
