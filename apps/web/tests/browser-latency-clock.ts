/** Browser-event clocks shared by synthetic and existing-deployment measurements. */
import type { Page } from 'playwright'

/** These times share the page's performance origin, never the driver's clock. */
export interface PreparationMarks { start: number; input?: number; ready?: number; runtime?: string }

/** Arm one click measurement without changing the application or issuing a request.
 * @param page - caller-owned page with one visible conversation.
 * @param history - optional exact historical view and known test marker required before readiness.
 */
export async function armPreparationClock(page: Page, history?: { sessionKey: string; marker: string }): Promise<void> {
  await page.evaluate((history) => {
    const state = window as Window & {
      __dshLatency?: { start: number; input?: number; ready?: number; runtime?: string }
      __dshLatencyStop?: () => void
    }
    state.__dshLatencyStop?.()
    delete state.__dshLatency
    let observer: MutationObserver | undefined
    const clicked = () => {
      const marks: { start: number; input?: number; ready?: number; runtime?: string } = { start: performance.now() }
      state.__dshLatency = marks
      const measure = () => {
        const box = document.querySelector<HTMLElement>('[data-conversation-intent]')
        const field = box?.querySelector('textarea')
        if (marks.input === undefined && field && !field.disabled) {
          marks.input = performance.now()
          if (box?.dataset.intentRuntime !== undefined) marks.runtime = box.dataset.intentRuntime
        }
        const historyReady = history === null || [...document.querySelectorAll<HTMLElement>('[data-conversation-session]')]
          .some(row => row.dataset.conversationSession === history.sessionKey && row.textContent?.includes(history.marker))
        if (marks.input !== undefined && !box && document.querySelector('textarea:enabled') && historyReady) {
          marks.ready = performance.now()
          observer?.disconnect()
        }
      }
      observer = new MutationObserver(measure)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      requestAnimationFrame(measure)
    }
    document.addEventListener('click', clicked, { capture: true, once: true })
    state.__dshLatencyStop = () => { observer?.disconnect(); document.removeEventListener('click', clicked, true) }
  }, history ?? null)
}
