/** Stable-node inspection for responsive surfaces whose controls can mount while scrolling. */
import type { ElementHandle, Locator, Page } from 'playwright'
import { expect } from 'vitest'

/** Receipt metadata: geometry for readable controls, size and sampled hit regions for enabled independent actions. */
export const responsiveControlAudit = { version: 'v9.2', checks: ['geometry', 'target-size', 'hit'] } as const

const actionSelector = [
  'button', 'input:not([type="hidden"])', 'select', 'textarea', 'a[href]', 'summary',
  '[role="button"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[role="tab"]', '[role="treeitem"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="combobox"]', '[role="textbox"]', '[contenteditable="true"]',
].join(', ')

/**
 * Inspect geometry, input-sized targets and pointer reach without activating controls.
 * Blocked actions get at most 32 legal scroll probes; exhaustion reports an incomplete search.
 * @param page - page with an explicit emulated viewport.
 * @param surface - visible feature surface, including the surface itself when it is an interactive control.
 * @param label - context attached to a failed geometry assertion.
 */
export async function auditResponsiveControls(page: Page, surface: Locator, label: string): Promise<void> {
  const selector = `${actionSelector}, label`
  const roots = await surface.elementHandles()
  const elements: Awaited<ReturnType<Locator['elementHandles']>> = []
  try {
    for (const root of roots) {
      if (await root.evaluate((node, selector) => node instanceof Element && node.matches(selector), selector)) elements.push(root)
    }
    elements.push(...await surface.locator(selector).elementHandles())
  } catch (error) {
    await Promise.all([...new Set([...roots, ...elements])].map(element => element.dispose()))
    throw error
  }
  await Promise.all(roots.filter(root => !elements.includes(root)).map(root => root.dispose()))
  await inspectResponsiveElements(page, elements, label)
}

/**
 * Inspect one control's geometry, target size and pointer reach without activating it.
 * @param page - page with a declared emulated viewport.
 * @param control - one visible control to bring into reach.
 * @param label - failure context identifying the interaction.
 * @param alignment - optional centering for a focused field near a scrollport edge.
 */
export async function auditResponsiveControl(page: Page, control: Locator, label: string,
  alignment: 'nearest' | 'center' = 'nearest'): Promise<void> {
  await control.waitFor({ state: 'visible' })
  const element = await control.elementHandle()
  if (element === null) throw new Error(`${label}: control disappeared before inspection`)
  await inspectResponsiveElements(page, [element], label, alignment)
}

async function inspectResponsiveElements(
  page: Page, elements: Awaited<ReturnType<Locator['elementHandles']>>, label: string,
  alignment: 'nearest' | 'center' = 'nearest',
): Promise<void> {
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error('Responsive controls require a declared viewport')
  try {
    for (const candidate of [...elements]) {
      const activationHandle = await candidate.evaluateHandle((node) => {
        if (!(node instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(node.type)) return node
        // A native label activates its associated checkbox even when the visual input is hidden.
        return [...node.labels ?? []].find(label => getComputedStyle(label).visibility === 'visible'
          && (getComputedStyle(label).display === 'contents' || [...label.getClientRects()].some(rect => rect.width > 0 && rect.height > 0))) ?? node
      })
      const activation = activationHandle.asElement()
      if (activation === null) { await activationHandle.dispose(); continue }
      elements.push(activation)
      const effective = await activation.evaluateHandle((node) => {
        if (!(node instanceof HTMLLabelElement) || getComputedStyle(node).display !== 'contents') return node
        return [...node.querySelectorAll('*')].filter(child => getComputedStyle(child).visibility === 'visible'
          && (child === node.control || !child.matches('button, a[href], select, textarea, [role="button"]')))
          .map(child => ({ child, rect: child.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0)
          .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.child ?? node
      })
      const element = effective.asElement()
      if (element === null) { await effective.dispose(); continue }
      elements.push(element)
      if (!await element.isVisible() && await activation.evaluate((node) => {
        if (!(node instanceof HTMLLabelElement) || getComputedStyle(node).display !== 'contents') return false
        const range = document.createRange(); range.selectNodeContents(node)
        return [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)
      })) throw new Error(`${label}: display:contents label has no element with a measurable activation region`)
      if (!await element.isVisible()) continue
      const inactive = await element.evaluate((node) => {
        if (!(node instanceof HTMLElement)) return false
        if (node instanceof HTMLLabelElement && !(node.control instanceof HTMLInputElement
          && ['checkbox', 'radio'].includes(node.control.type))) return true
        const parent = (element: Element): Element | null => {
          const root = element.getRootNode()
          return element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
        }
        // A closed details paints only its summary children. WebKit still lays
        // out the other descendants, so a bounding box alone cannot tell they
        // are unpainted and unhittable; walk the composed tree instead.
        let lineageChild: Element = node
        for (let ancestor = parent(node); ancestor !== null; ancestor = parent(ancestor)) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !(lineageChild instanceof HTMLElement
            && lineageChild.tagName === 'SUMMARY')) return true
          lineageChild = ancestor
        }
        const lineage: Element[] = []
        for (let ancestor: Element | null = node; ancestor !== null; ancestor = parent(ancestor)) lineage.push(ancestor)
        for (const ancestor of lineage) {
          if (ancestor instanceof HTMLElement && ancestor.inert) return true
          if (ancestor.matches(':modal')) break
        }
        const modals = [...document.querySelectorAll<HTMLDialogElement>(':modal')]
        if (modals.length > 0) {
          // A native modal makes its document inert without adding inert attributes.
          let active = document.activeElement?.closest(':modal')
          for (const modal of modals) {
            const rect = modal.getBoundingClientRect()
            const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
              Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)))?.closest(':modal')
            if (hit !== undefined && hit !== null) { active = hit; break }
          }
          if (active !== undefined && active !== null && !lineage.includes(active)) return true
          if (!lineage.some(ancestor => ancestor.matches(':modal'))) return true
        }
        if (lineage.some(ancestor => ancestor.getAttribute('aria-hidden') === 'true')
          && node.tabIndex < 0 && getComputedStyle(node).pointerEvents === 'none') return true
        return node.matches('[role="button"], [role="menuitem"], [role="tab"], [role="treeitem"]')
          && !node.matches('button, a[href], summary, input, select, textarea') && !node.hasAttribute('tabindex')
          && node.querySelector('button, a[href], input, select, textarea, [tabindex], [role="treeitem"]') !== null
      })
      if (inactive) continue
      const clippingAncestors = await element.evaluateHandle((node) => {
        const ancestors: Array<{
          element: Element
          x: boolean
          y: boolean
          hiddenX: boolean
          hiddenY: boolean
          left: number
          top: number
        }> = []
        if (!(node instanceof Element)) throw new Error('Responsive control is not an Element')
        let animating = node.getAnimations().some(animation => animation.playState === 'running' || animation.pending)
        let topLayer = node.matches(':modal, :popover-open')
        const positioned = (element: Element): 'absolute' | 'fixed' | undefined => {
          const position = getComputedStyle(element).position
          return position === 'absolute' || position === 'fixed' ? position : undefined
        }
        const parent = (element: Element): Element | null => {
          const root = element.getRootNode()
          return element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
        }
        let escaping = positioned(node)
        for (let ancestor = topLayer ? null : parent(node); ancestor !== null; ancestor = parent(ancestor)) {
          animating ||= ancestor.getAnimations().some(animation => animation.playState === 'running' || animation.pending)
          const style = getComputedStyle(ancestor)
          const transforms = ['transform', 'perspective', 'filter', 'backdrop-filter', 'rotate', 'scale', 'translate']
          const containing = transforms.some((property) => {
            const value = style.getPropertyValue(property)
            return value !== '' && value !== 'none'
          }) || /\b(layout|paint|strict|content)\b/.test(style.contain)
            || style.willChange.split(',').some(property => [...transforms, 'contain'].includes(property.trim()))
            || style.contentVisibility === 'auto'
          if (escaping !== undefined && (containing || escaping === 'absolute' && style.position !== 'static')) escaping = undefined
          if (escaping === undefined) {
            const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX), y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY)
            if (x || y) ancestors.push({ element: ancestor, x, y,
              hiddenX: /^(hidden|clip)$/.test(style.overflowX), hiddenY: /^(hidden|clip)$/.test(style.overflowY),
              left: ancestor.scrollLeft, top: ancestor.scrollTop })
            escaping = positioned(ancestor)
          }
          // Positioned descendants escape intermediate clips until their containing block.
          if (ancestor.matches(':modal, :popover-open')) { topLayer = true; break }
        }
        const rootAllows = (axis: 'x' | 'y') => {
          const html = getComputedStyle(document.documentElement), body = getComputedStyle(document.body)
          const propagated = html.overflowX === 'visible' && html.overflowY === 'visible'
            && html.contain === 'none' && body.contain === 'none' && body.display !== 'none' ? body : html
          return !/^(hidden|clip)$/.test(axis === 'x' ? propagated.overflowX : propagated.overflowY)
        }
        const measure = () => {
          const rect = node.getBoundingClientRect()
          let left = 0, top = 0, right = innerWidth, bottom = innerHeight, hiddenClipped = false
          // Viewport overflow is reachability's concern, not clipping's: a
          // scrollable ancestor makes it reachable, and reachableOverflow
          // below flags whatever no scroll can reach.
          let clipLeft = -Infinity, clipTop = -Infinity, clipRight = Infinity, clipBottom = Infinity
          let innerScrollX = false, innerScrollY = false
          for (const { element: ancestor, x, y, hiddenX, hiddenY } of ancestors) {
            const bounds = ancestor.getBoundingClientRect()
            if (x) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right) }
            if (y) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom) }
            hiddenClipped ||= hiddenX && !innerScrollX && (rect.right <= bounds.left || rect.left >= bounds.right)
              || hiddenY && !innerScrollY && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)
            innerScrollX ||= x && !hiddenX && ancestor.scrollWidth > ancestor.clientWidth
            innerScrollY ||= y && !hiddenY && ancestor.scrollHeight > ancestor.clientHeight
            // Scrollable ancestors reveal clipped content by scrolling; only a
            // hidden or clip ancestor makes residual overflow unreachable.
            if (hiddenX) { clipLeft = Math.max(clipLeft, bounds.left); clipRight = Math.min(clipRight, bounds.right) }
            if (hiddenY) { clipTop = Math.max(clipTop, bounds.top); clipBottom = Math.min(clipBottom, bounds.bottom) }
          }
          // Reachability means every point can be brought into view. Vertical
          // document scroll covers ordinary in-flow overflow, and a scrollable
          // ancestor (a wide table, a code block) covers its own axis; a
          // horizontally scrolling document does not excuse the page's width.
          const scrolling = document.scrollingElement
          const scrollsX = ancestors.some(({ element: ancestor, x, hiddenX }) =>
            ancestor !== scrolling && x && !hiddenX && ancestor.scrollWidth > ancestor.clientWidth)
          const scrollsY = ancestors.some(({ element: ancestor, y, hiddenY }) =>
            y && !hiddenY && ancestor.scrollHeight > ancestor.clientHeight)
            || (scrolling !== null && !ancestors.some(({ element }) => element === scrolling)
              && scrolling.scrollHeight > scrolling.clientHeight && rootAllows('y'))
          const reachableOverflow = Math.max(
            scrollsX ? 0 : Math.max(-rect.left, rect.right - innerWidth),
            scrollsY ? 0 : Math.max(-rect.top, rect.bottom - innerHeight))
          return { overflow: Math.max(left - rect.left, top - rect.top, rect.right - right, rect.bottom - bottom),
            clipOverflow: Math.max(clipLeft - rect.left, clipTop - rect.top,
              rect.right - clipRight, rect.bottom - clipBottom),
            reachableOverflow,
            hiddenClipped,
            ancestors: ancestors.map(({ element: ancestor, x, y }) => {
              const bounds = ancestor.getBoundingClientRect()
              return { tag: ancestor.tagName, className: ancestor.className, x, y,
                bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
                scroll: { left: ancestor.scrollLeft, top: ancestor.scrollTop } }
            }), control: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }
        }
        const createScrollProbe = () => {
          const scrollers = ancestors.filter(({ element: ancestor, x, y, hiddenX, hiddenY }) =>
            x && !hiddenX && ancestor.scrollWidth > ancestor.clientWidth
            || y && !hiddenY && ancestor.scrollHeight > ancestor.clientHeight)
            .map(({ element: ancestor, x, y, hiddenX, hiddenY }) => ({
              element: ancestor, x: x && !hiddenX && ancestor.scrollWidth > ancestor.clientWidth,
              y: y && !hiddenY && ancestor.scrollHeight > ancestor.clientHeight, root: false,
            }))
          const scrolling = document.scrollingElement
          for (const entry of scrollers) {
            if (entry.element !== scrolling) continue
            entry.root = true
            entry.x &&= rootAllows('x')
            entry.y &&= rootAllows('y')
          }
          if (!topLayer && scrolling !== null && !ancestors.some(({ element }) => element === scrolling)) {
            scrollers.push({ element: scrolling, root: true,
              x: scrolling.scrollWidth > scrolling.clientWidth && rootAllows('x'),
              y: scrolling.scrollHeight > scrolling.clientHeight && rootAllows('y'),
            })
          }
          const positions = () => scrollers.map(({ element: ancestor }) => ({ left: ancestor.scrollLeft, top: ancestor.scrollTop }))
          const original = positions()
          const apply = (next: typeof original) => {
            for (const [index, entry] of scrollers.entries()) {
              const style = getComputedStyle(entry.element), point = next[index]!
              for (const axis of ['x', 'y'] as const) {
                const changing = axis === 'x' ? Math.abs(point.left - entry.element.scrollLeft) > 1
                  : Math.abs(point.top - entry.element.scrollTop) > 1
                const overflow = axis === 'x' ? style.overflowX : style.overflowY
                const rootAllowed = entry.root && rootAllows(axis)
                if (changing && (!entry[axis] || !(entry.root ? rootAllowed : /^(auto|scroll)$/.test(overflow)))) {
                  throw new Error('Hit probe cannot move an axis that is no longer user-scrollable')
                }
              }
            }
            for (const [index, entry] of scrollers.entries()) entry.element.scrollTo({ ...next[index]!, behavior: 'instant' })
            return positions()
          }
          const candidates = (obstructions: Array<{ left: number; top: number; right: number; bottom: number }>) => {
            const current = positions()
            // A wrapped control is several fragments; the union's center can
            // sit inside the window while every fragment lies outside it.
            // Scroll toward each fragment so at least one becomes hittable.
            const pieces = node.getClientRects()
            const fragments = pieces.length > 0 ? [...pieces] : [node.getBoundingClientRect()]
            const result: Array<typeof current> = []
            for (const [index, entry] of scrollers.entries()) {
              const bounds = entry.element.getBoundingClientRect()
              const scaleX = entry.root || !(entry.element instanceof HTMLElement) ? 1 : bounds.width / entry.element.offsetWidth
              const scaleY = entry.root || !(entry.element instanceof HTMLElement) ? 1 : bounds.height / entry.element.offsetHeight
              // The window a scroller can bring a fragment into is its own
              // scrollport intersected with clipping ancestors outside it.
              // Ancestors inside its scrollport move together with the
              // control, so their bounds do not shrink the destination
              // window — a fixed overlay above a scrolled document is what
              // actually blocks the hit, and obstructions steer around it.
              let left = 0, top = 0, right = innerWidth, bottom = innerHeight
              for (const { element: ancestor, x, y } of ancestors) {
                if (ancestor !== entry.element && entry.element.contains(ancestor)) continue
                const ancestorBounds = ancestor.getBoundingClientRect()
                if (x) { left = Math.max(left, ancestorBounds.left); right = Math.min(right, ancestorBounds.right) }
                if (y) { top = Math.max(top, ancestorBounds.top); bottom = Math.min(bottom, ancestorBounds.bottom) }
              }
              for (const axis of ['y', 'x'] as const) {
                if (!entry[axis]) continue
                const start = axis === 'y' ? top : left, end = axis === 'y' ? bottom : right
                for (const fragment of fragments) {
                  const extent = axis === 'y' ? fragment.height : fragment.width
                  const center = axis === 'y' ? fragment.top + fragment.height / 2 : fragment.left + fragment.width / 2
                  const destinations = [(start + end) / 2, start + extent / 2 + 1, end - extent / 2 - 1,
                    ...obstructions.flatMap(blocker => axis === 'y'
                      ? [blocker.top - extent / 2 - 1, blocker.bottom + extent / 2 + 1]
                      : [blocker.left - extent / 2 - 1, blocker.right + extent / 2 + 1])]
                  // A control wider than its clip window can never be fully
                  // inside it; the sampled points only need their own fragment
                  // in view, so the center just has to land inside the window.
                  const fits = extent <= end - start
                  for (const destination of destinations) {
                    if (fits
                      ? destination - extent / 2 < start || destination + extent / 2 > end
                      : destination < start || destination > end) continue
                    const delta = (center - destination) / (axis === 'y' ? scaleY : scaleX)
                    if (!Number.isFinite(delta) || Math.abs(delta) <= 1) continue
                    const next = current.map(point => ({ ...point }))
                    if (axis === 'y') next[index]!.top += delta
                    else next[index]!.left += delta
                    result.push(next)
                  }
                }
              }
            }
            return result
          }
          return { positions, candidates, apply, restore: () => apply(original) }
        }
        return { ancestors, measure, createScrollProbe, initiallyReachable: !animating && measure().overflow <= 1 }
      })
      try {
        const initialClipping = await clippingAncestors.evaluate(({ measure }) => measure())
        expect(initialClipping.hiddenClipped,
          `${label}: control requires scrolling a non-scrollable hidden or clip ancestor ${JSON.stringify(initialClipping)}`).toBe(false)
        if (alignment === 'center' || !await clippingAncestors.evaluate(({ initiallyReachable }) => initiallyReachable)) {
          try { await element.scrollIntoViewIfNeeded() }
          catch (error) {
            // Responsive panels can replace a control while its scroll action waits for animation stability.
            if (!await element.evaluate(node => node.isConnected)) continue
            throw error
          }
          // Playwright skips the scroll while any fragment stays visible, so an
          // inner scrollport can keep the control clipped; the DOM reveal moves
          // every scrollable ancestor regardless of the current intersection.
          await element.evaluate((node) => {
            if (node instanceof Element) node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
          })
        }
        if (alignment === 'center') await element.evaluate((node) => {
          if (node instanceof Element) node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        })
        if (!await element.isVisible()) continue
        // Screen-reader-only controls clipped to zero area (a skip link before
        // focus, a `.visually-hidden` affordance) accept keyboard, not pointer,
        // activation, so they are not targets. A partially clipped control
        // still paints and stays audited.
        if (await element.evaluate((node) => {
          if (!(node instanceof Element)) return false
          const style = getComputedStyle(node)
          const zeroClip = (() => {
            const bounds = /^rect\(([^)]+)\)$/.exec(style.getPropertyValue('clip'))?.[1]
            if (bounds === undefined) return false
            const [top, right, bottom, left] = bounds.split(/[ ,]+/).map(Number.parseFloat)
            return right! <= left! || bottom! <= top!
          })()
          const zeroInset = (() => {
            const bounds = /^inset\(([^)]+)\)$/.exec(style.clipPath)?.[1]
            if (bounds === undefined) return false
            const box = node.getBoundingClientRect()
            const axes = [box.height, box.width, box.height, box.width]
            const values = bounds.trim().split(/\s+/).map((token, index) => {
              const fraction = token.endsWith('%') ? Number.parseFloat(token) / 100 : Number.parseFloat(token) / (axes[index] ?? 1)
              return Number.isFinite(fraction) ? fraction : 0
            })
            const [t = 0, r = t, b = t, l = r] = values
            return t + b >= 1 || l + r >= 1
          })()
          return zeroClip || zeroInset
        })) continue
        const forcedScroll = await clippingAncestors.evaluate(({ ancestors }) => ancestors
          .filter(({ element: ancestor, hiddenX, hiddenY, left, top }) => ancestor.isConnected
            && (hiddenX && Math.abs(ancestor.scrollLeft - left) > 1 || hiddenY && Math.abs(ancestor.scrollTop - top) > 1))
          .map(({ element: ancestor, left, top }) => ({ tag: ancestor.tagName, className: ancestor.className,
            before: { left, top }, after: { left: ancestor.scrollLeft, top: ancestor.scrollTop } })))
        expect(forcedScroll, `${label}: control requires scrolling a non-scrollable hidden or clip ancestor`).toEqual([])
        const box = await element.boundingBox()
        expect(box, `${label}: visible control bounds`).not.toBeNull()
        const description = await element.evaluate(node => node instanceof Element ? node.outerHTML.slice(0, 300) : node.nodeName)
        const clipping = await clippingAncestors.evaluate(({ measure }) => measure())
        expect(clipping.reachableOverflow,
          `${label}: reachable control ${description}; ${JSON.stringify({ box, viewport, clipping })}`).toBeLessThanOrEqual(1)
        // Residual overflow inside a scrollable ancestor is still reachable a
        // fragment at a time; the hit probes below scroll it into each point.
        expect(clipping.clipOverflow, `${label}: unclipped control ${description}; ${JSON.stringify(clipping)}`).toBeLessThanOrEqual(1)
        let target = await inspectPointerTarget(element, activation)
        if (!target.interactive || target.disabled) continue
        expect(target.sized, `${label}: effective ${target.minimum}px target ${description}; ${JSON.stringify(target)}`).toBe(true)
        let hit = await reachableFramePoints(element, target.regions)
        const attempts: unknown[] = []
        let probeLimited = false
        if (hit.length === 0) {
          const probe = await clippingAncestors.evaluateHandle(({ createScrollProbe }) => createScrollProbe())
          let reached = false
          try {
            const queue = await probe.evaluate((state, blockers) => state.candidates(blockers), target.obstructions)
            const initial = await probe.evaluate(state => state.positions())
            const key = (positions: typeof initial) => positions.map(point => `${point.left.toFixed(1)},${point.top.toFixed(1)}`).join(';')
            const visited = new Set([key(initial)]), queued = new Set(queue.map(key))
            for (let applied = 0; queue.length > 0 && applied < 32; applied++) {
              const next = queue.shift()!
              await probe.evaluate((state, next) => { state.apply(next) }, next)
              await element.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
                requestAnimationFrame(() => { resolve() })
              })))
              if (!await element.evaluate(node => node.isConnected)) throw new Error(`${label}: actual pointer hit probe detached its target`)
              const actual = await probe.evaluate(state => state.positions())
              const movedHidden = await clippingAncestors.evaluate(({ ancestors }) => ancestors
                .some(({ element: ancestor, hiddenX, hiddenY, left, top }) =>
                  hiddenX && Math.abs(ancestor.scrollLeft - left) > 1 || hiddenY && Math.abs(ancestor.scrollTop - top) > 1))
              expect(movedHidden, `${label}: hit retry moved a non-scrollable hidden or clip ancestor`).toBe(false)
              const positionKey = key(actual)
              if (visited.has(positionKey)) continue
              visited.add(positionKey)
              const current = await clippingAncestors.evaluate(({ measure }) => measure())
              const movedBox = await element.boundingBox()
              target = await inspectPointerTarget(element, activation)
              hit = current.reachableOverflow <= 1 && current.clipOverflow <= 1
                && target.interactive && !target.disabled && target.sized
                ? await reachableFramePoints(element, target.regions) : []
              attempts.push({ positions: actual, box: movedBox, viewport, clipping: current,
                blocked: target.blocked, reached: hit.length > 0 })
              if (hit.length > 0) { reached = true; break }
              for (const candidate of await probe.evaluate((state, blockers) => state.candidates(blockers), target.obstructions)) {
                const candidateKey = key(candidate)
                if (queued.has(candidateKey) || visited.has(candidateKey)) continue
                queued.add(candidateKey); queue.push(candidate)
              }
            }
            probeLimited = !reached && queue.length > 0
          } finally {
            try { if (!reached) await probe.evaluate((state) => { state.restore() }) }
            finally { await probe.dispose() }
          }
        }
        expect(hit.length, `${label}: actual pointer hit reaches the control ${description}; ${JSON.stringify({
          target, attempts, probeLimited,
          conclusion: probeLimited ? 'bounded scroll probe incomplete' : 'no sampled reachable position',
        })}`).toBeGreaterThan(0)
      } finally { await clippingAncestors.dispose() }
    }
  } finally { await Promise.all(elements.map(element => element.dispose())) }
}

interface TargetPoint { x: number; y: number }

interface TargetFailureGeometry {
  required: { width: number; height: number; frameScaleX: number; frameScaleY: number }
  rects: Array<{ left: number; top: number; width: number; height: number }>
  generatedArea: boolean
  ancestry: Array<{
    tag: string
    className: string
    rect: { left: number; top: number; width: number; height: number }
    offsetWidth: number | null
    offsetHeight: number | null
    computed: Record<string, string>
    finiteAnimations: Array<{
      id: string
      playState: string
      pending: boolean
      currentTime: number | string | null
      progress: number | null
      duration: string | null
      endTime: number
    }>
  }>
}

async function inspectPointerTarget(element: ElementHandle, activation: ElementHandle): Promise<{
  interactive: boolean
  disabled: boolean
  minimum: number
  sized: boolean
  sizeException: 'inline-text' | null
  regions: TargetPoint[][]
  blocked: string[]
  obstructions: Array<{ left: number; top: number; right: number; bottom: number }>
  failureGeometry?: TargetFailureGeometry
}> {
  let frame = await element.ownerFrame(), scaleX = 1, scaleY = 1
  while (frame !== null && frame.parentFrame() !== null) {
    const host = await frame.frameElement()
    try {
      const scale = await host.evaluate((node) => {
        if (!(node instanceof HTMLElement)) throw new Error('Frame element is not an HTML element')
        const rect = node.getBoundingClientRect()
        return { x: rect.width / node.offsetWidth, y: rect.height / node.offsetHeight }
      })
      scaleX *= scale.x; scaleY *= scale.y
    } finally { await host.dispose() }
    frame = frame.parentFrame()
  }
  return element.evaluate((node, scale) => {
    if (!(node instanceof Element)) throw new Error('Pointer target is not an Element')
    if (!(scale.activation instanceof Element)) throw new Error('Pointer activation target is not an Element')
    const owner = scale.activation
    const parent = (element: Element): Element | null => element.assignedSlot ?? element.parentElement
      ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null)
    const control = owner instanceof HTMLLabelElement ? owner.control ?? owner : owner
    const interactive = owner.matches(scale.selector)
      || owner instanceof HTMLLabelElement && owner.control !== null
    let disabled = control.matches(':disabled')
    for (let ancestor: Element | null = control; ancestor !== null; ancestor = parent(ancestor)) {
      disabled ||= ancestor.getAttribute('aria-disabled') === 'true'
    }
    const minimum = matchMedia('(pointer: coarse)').matches ? 44 : 24
    const width = minimum / scale.x, height = minimum / scale.y
    const style = getComputedStyle(node)
    const inlineText = (): boolean => {
      if (!owner.matches('button, a[href], [role="button"]')
        || owner.hasAttribute('role') && !owner.matches('[role="button"], [role="link"]')) return false
      if (!['inline', 'inline-flex', 'inline-block', 'inline-grid'].includes(style.display)
        || !['static', 'relative'].includes(style.position)) return false
      for (let ancestor: Element | null = owner; ancestor !== null; ancestor = parent(ancestor)) {
        if (ancestor.matches('nav, menu, [role="navigation"], [role="menu"], [role="menubar"], '
          + '[role="tablist"], [role="toolbar"], [role="tree"], [role="listbox"]')) return false
      }
      let flow = parent(node)
      while (flow !== null && ['inline', 'contents'].includes(getComputedStyle(flow).display)) flow = parent(flow)
      // Table cells hold blocks of text; their links get the same inline
      // treatment as paragraph and list-item prose.
      if (flow === null || !['block', 'flow-root', 'list-item', 'table-cell'].includes(getComputedStyle(flow).display)) return false
      const text = document.createTreeWalker(flow, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(candidate) {
          if (candidate instanceof Element) {
            const candidateStyle = getComputedStyle(candidate)
            if (candidate.matches(scale.selector) || candidate instanceof HTMLLabelElement && candidate.control !== null
              || !['inline', 'contents'].includes(candidateStyle.display)
              || candidateStyle.visibility !== 'visible' || Number(candidateStyle.opacity) === 0
              || candidate.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT
            return NodeFilter.FILTER_SKIP
          }
          return /[\p{L}\p{N}]/u.test(candidate.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        },
      })
      const vertical = style.writingMode.startsWith('vertical')
      // An inline link wrapping onto multiple lines has a union rect taller
      // than one line; each wrapped fragment is what line-height constrains.
      const fragments = [...node.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
      const union = node.getBoundingClientRect()
      const extent = fragments.length === 0
        ? vertical ? union.width : union.height
        : vertical
          ? Math.max(...fragments.map(rect => rect.width))
          : Math.max(...fragments.map(rect => rect.height))
      for (let run = text.nextNode(); run !== null; run = text.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(run)
        const runStyle = getComputedStyle(run.parentElement ?? flow)
        for (const fragment of range.getClientRects()) {
          if (fragment.width <= 0 || fragment.height <= 0) continue
          const lineHeight = Number.parseFloat(runStyle.lineHeight)
          const available = Number.isFinite(lineHeight) ? lineHeight : vertical ? fragment.width : fragment.height
          if (extent <= available + 1) return true
        }
      }
      return false
    }
    // WCAG 2.5.8/2.5.5 inline exceptions also cover actions embedded in non-target prose.
    const sizeException = inlineText() ? 'inline-text' : null
    const requireSize = sizeException === null
    const rects = [...node.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
    const generatedArea = ['::before', '::after'].some((pseudo) => {
      const generated = getComputedStyle(node, pseudo)
      const dimension = (axis: 'width' | 'height') => {
        const sides = axis === 'width' ? ['left', 'right'] : ['top', 'bottom']
        return Number.parseFloat(generated.getPropertyValue(axis)) + (generated.boxSizing === 'border-box' ? 0
          : sides.reduce((total, side) => total + Number.parseFloat(generated.getPropertyValue(`padding-${side}`))
            + Number.parseFloat(generated.getPropertyValue(`border-${side}-width`)), 0))
      }
      const bounds = node.getBoundingClientRect()
      // offsetWidth/Height round the border box to whole pixels, so an untransformed
      // element can report a ratio down to ~0.5px off 1 — snap that rounding noise to
      // 1 and keep the factor only for a real transform/zoom gap.
      const scaleOf = (rendered: number, layout: number): number =>
        Math.abs(rendered - layout) > 0.5 ? rendered / layout : 1
      const transformX = node instanceof HTMLElement ? scaleOf(bounds.width, node.offsetWidth) : 1
      const transformY = node instanceof HTMLElement ? scaleOf(bounds.height, node.offsetHeight) : 1
      return generated.content !== 'none' && generated.content !== 'normal'
        && generated.position === 'absolute' && generated.pointerEvents !== 'none'
        && dimension('width') * transformX >= width - .1 && dimension('height') * transformY >= height - .1
    })
    const candidates = rects.filter(rect => !requireSize || generatedArea || rect.width >= width - .1 && rect.height >= height - .1)
    const accepts = (hit: Element | null): boolean => {
      for (let current = hit; current !== null; current = parent(current)) {
        if (current === owner || current === control) return true
        if (current.matches(scale.selector)) return false
      }
      return false
    }
    const hitAt = ({ x, y }: TargetPoint): Element | null => {
      let hit = document.elementFromPoint(x, y)
      while (hit?.shadowRoot !== null && hit?.shadowRoot !== undefined) {
        const inner = hit.shadowRoot.elementFromPoint(x, y)
        if (inner === null || inner === hit) break
        hit = inner
      }
      return hit
    }
    const blocked: string[] = [], regions: TargetPoint[][] = [], obstructions = new Set<Element>()
    const regionsToInspect = candidates.flatMap((rect) => {
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
      if (!(owner instanceof HTMLLabelElement)) return [{ x, y }]
      const xs = [...new Set([x, rect.left + width / 2, rect.right - width / 2])]
      const ys = [...new Set([y, rect.top + height / 2, rect.bottom - height / 2])]
      return xs.flatMap(x => ys.map(y => ({ x, y })))
    })
    for (const center of regionsToInspect) {
      // Sampling one fragment avoids counting gaps between wrapped label lines as a target.
      const x = (width - 2) / 2, y = (height - 2) / 2
      const offsets = requireSize ? [[0, 0], [-x, 0], [x, 0], [0, -y], [0, y],
        [-x * .7, -y * .7], [x * .7, -y * .7], [-x * .7, y * .7], [x * .7, y * .7]] : [[0, 0]]
      let reachable = true
      const points: TargetPoint[] = []
      for (const [dx = 0, dy = 0] of offsets) {
        const point = { x: center.x + dx, y: center.y + dy }, hit = hitAt(point)
        points.push(point)
        if (!accepts(hit)) {
          reachable = false; blocked.push(`${point.x},${point.y}: ${hit?.outerHTML.slice(0, 140) ?? 'no hit'}`)
          if (hit !== null) {
            let blocker = hit
            for (let ancestor: Element | null = hit; ancestor !== null && !ancestor.contains(node); ancestor = parent(ancestor)) {
              if (ancestor.matches(scale.selector) || /^(fixed|sticky)$/.test(getComputedStyle(ancestor).position)) {
                blocker = ancestor; break
              }
            }
            obstructions.add(blocker)
          }
        }
      }
      if (reachable) regions.push(points)
    }
    const sized = !requireSize || candidates.length > 0
    const failureGeometry = interactive && !disabled && (!sized || regions.length === 0) ? (() => {
      const rectangle = (rect: DOMRect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      const ancestry: TargetFailureGeometry['ancestry'] = []
      for (let ancestor: Element | null = node; ancestor !== null; ancestor = parent(ancestor)) {
        const computed = getComputedStyle(ancestor)
        ancestry.push({
          tag: ancestor.tagName,
          className: ancestor.getAttribute('class') ?? '',
          rect: rectangle(ancestor.getBoundingClientRect()),
          offsetWidth: ancestor instanceof HTMLElement ? ancestor.offsetWidth : null,
          offsetHeight: ancestor instanceof HTMLElement ? ancestor.offsetHeight : null,
          computed: Object.fromEntries(['width', 'height', 'min-width', 'min-height', 'box-sizing',
            'transform', 'scale', 'translate', 'zoom', 'animation-name', 'animation-duration',
            'animation-play-state'].map(property => [property, computed.getPropertyValue(property)])),
          finiteAnimations: ancestor.getAnimations().flatMap((animation) => {
            const timing = animation.effect?.getComputedTiming()
            if (typeof timing?.endTime !== 'number' || !Number.isFinite(timing.endTime)) return []
            const currentTime = animation.currentTime
            return [{ id: animation.id, playState: animation.playState, pending: animation.pending,
              currentTime: typeof currentTime === 'number' || currentTime === null ? currentTime : String(currentTime),
              progress: timing.progress ?? null,
              duration: timing.duration === undefined ? null : String(timing.duration), endTime: timing.endTime }]
          }),
        })
      }
      return { required: { width, height, frameScaleX: scale.x, frameScaleY: scale.y },
        rects: rects.map(rectangle), generatedArea, ancestry }
    })() : undefined
    return { interactive, disabled, minimum, sizeException, sized, regions, blocked,
      ...(failureGeometry === undefined ? {} : { failureGeometry }),
      obstructions: [...obstructions].map((element) => {
        const { left, top, right, bottom } = element.getBoundingClientRect()
        return { left, top, right, bottom }
      }) }
  }, { x: scaleX, y: scaleY, selector: actionSelector, activation })
}

async function reachableFramePoints(element: ElementHandle, localRegions: TargetPoint[][]): Promise<TargetPoint[][]> {
  let regions = localRegions
  let frame = await element.ownerFrame()
  while (frame !== null && frame.parentFrame() !== null && regions.length > 0) {
    const frameElement = await frame.frameElement()
    const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    try {
      regions = await frameElement.evaluate((node, { regions, viewport }) => {
        if (!(node instanceof HTMLElement)) throw new Error('Frame element is not an HTML element')
        const rect = node.getBoundingClientRect()
        const scaleX = rect.width / node.offsetWidth, scaleY = rect.height / node.offsetHeight
        return regions.map(points => points.map(point => ({
          x: rect.left + (node.clientLeft + point.x * node.clientWidth / viewport.width) * scaleX,
          y: rect.top + (node.clientTop + point.y * node.clientHeight / viewport.height) * scaleY })))
          .filter(points => points.every(({ x, y }) => {
            let hit = document.elementFromPoint(x, y)
            while (hit?.shadowRoot !== null && hit?.shadowRoot !== undefined) {
              const inner = hit.shadowRoot.elementFromPoint(x, y)
              if (inner === null || inner === hit) break
              hit = inner
            }
            return hit === node
          }))
      }, { regions, viewport })
    } finally { await frameElement.dispose() }
    frame = frame.parentFrame()
  }
  return regions
}
