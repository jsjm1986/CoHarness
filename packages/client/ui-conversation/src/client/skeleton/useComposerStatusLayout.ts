/** Keeps the same status controls mounted as their composer placement changes. */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

const TOOL_GAP = '--composer-tool-gap'

interface StatusSeat {
  toolbar: RefObject<HTMLDivElement | null>
  footer: RefObject<HTMLDivElement | null>
  mount: HTMLDivElement | null
}

function useStatusSeat(name: string): StatusSeat {
  const toolbar = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLDivElement>(null)
  const [mount] = useState(() => {
    if (typeof document === 'undefined') return null
    const element = document.createElement('div')
    element.dataset.composerStatus = name
    return element
  })
  return { toolbar, footer, mount }
}

function place(mount: HTMLElement, destination: HTMLElement): void {
  if (mount.parentElement === destination) return
  if (typeof destination.moveBefore === 'function' && mount.isConnected && destination.isConnected) {
    destination.moveBefore(mount, null)
    return
  }
  const active = mount.ownerDocument.activeElement
  const focused = active instanceof HTMLElement && mount.contains(active) ? active : null
  destination.append(mount)
  focused?.focus({ preventScroll: true })
}

// Slots and layout-only wrappers can expose more than one in-flow flex item.
function controlWidths(lane: Element, statusMounts: readonly HTMLElement[]): number[] {
  const widths: number[] = []
  for (const item of lane.children) {
    if (statusMounts.some(mount => mount === item)) continue
    const { display, position } = getComputedStyle(item)
    if (display === 'none' || position === 'absolute' || position === 'fixed') continue
    if (display === 'contents') {
      widths.push(...controlWidths(item, statusMounts))
    } else {
      const { width } = item.getBoundingClientRect()
      if (width > 0) widths.push(width)
    }
  }
  return widths
}

/**
 * Fit a compact toolbar to its available width, then move the context and
 * optional status trigger in priority order. Both destinations are in flow.
 * @param rowRef - the toolbar containing the leading and trailing flex groups.
 * @returns stable portal mounts and the refs for their toolbar and footer destinations.
 */
export function useComposerStatusLayout(rowRef: RefObject<HTMLDivElement | null>): {
  context: StatusSeat
  status: StatusSeat
} {
  const context = useStatusSeat('context')
  const status = useStatusSeat('extension')
  const { mount: contextMount, toolbar: contextToolbar, footer: contextFooter } = context
  const { mount: statusMount, toolbar: statusToolbar, footer: statusFooter } = status

  useLayoutEffect(() => {
    const row = rowRef.current
    const contextInline = contextToolbar.current
    const contextBelow = contextFooter.current
    const statusInline = statusToolbar.current
    const statusBelow = statusFooter.current
    if (!row || !contextMount || !statusMount || !contextInline || !contextBelow || !statusInline || !statusBelow) return

    place(contextMount, contextInline)
    place(statusMount, statusInline)
    const mounts = [contextMount, statusMount]
    const frame = row.closest('[data-viewport]')
    const composer = row.closest('[data-composer-tool-layout]')
    let pending: number | undefined

    const fit = (): void => {
      pending = undefined
      if (frame?.getAttribute('data-viewport') !== 'compact'
        && composer?.getAttribute('data-composer-tool-layout') !== 'compact') {
        row.style.removeProperty(TOOL_GAP)
        place(contextMount, contextInline)
        place(statusMount, statusInline)
        return
      }
      const available = row.getBoundingClientRect().width
      if (available === 0) return
      const target = Number.parseFloat(getComputedStyle(row).getPropertyValue('--dsw-touch-target'))
      if (!(target > 0)) return
      const core = Array.from(row.children).flatMap(lane => controlWidths(lane, mounts))
      const hasContext = contextMount.querySelector('button') !== null
      const hasStatus = statusMount.querySelector('button') !== null
      let count = core.length + Number(hasContext) + Number(hasStatus)
      let used = core.reduce((sum, width) => sum + width, 0) + target * (count - core.length)
      const moveContext = hasContext && used > available
      if (moveContext) { used -= target; count-- }
      const moveExtension = hasStatus && used > available
      if (moveExtension) { used -= target; count-- }
      const value = `max(0px, (100cqi - ${used}px) / ${Math.max(1, count - 1)})`
      if (row.style.getPropertyValue(TOOL_GAP) !== value) row.style.setProperty(TOOL_GAP, value)
      place(contextMount, moveContext ? contextBelow : contextInline)
      place(statusMount, moveExtension ? statusBelow : statusInline)
    }
    const schedule = () => { pending ??= requestAnimationFrame(fit) }
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined
    resize?.observe(row)
    for (const lane of row.children) resize?.observe(lane)
    const changes = new MutationObserver(schedule)
    changes.observe(row, { childList: true, subtree: true })
    for (const mount of mounts) {
      changes.observe(mount, { childList: true, subtree: true })
    }
    if (frame !== null) changes.observe(frame, { attributeFilter: ['data-viewport'] })
    if (composer !== null) changes.observe(composer, { attributeFilter: ['data-composer-tool-layout'] })
    fit()
    return () => {
      if (pending !== undefined) cancelAnimationFrame(pending)
      resize?.disconnect()
      changes.disconnect()
      for (const mount of mounts) mount.remove()
      row.style.removeProperty(TOOL_GAP)
    }
  }, [rowRef, contextMount, contextToolbar, contextFooter, statusMount, statusToolbar, statusFooter])

  return { context, status }
}
