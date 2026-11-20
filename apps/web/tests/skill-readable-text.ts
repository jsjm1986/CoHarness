/** Visible instruction witnesses inside the skill source and recorded-output scrollports. */
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'

/**
 * Scroll exact instruction text into the reading area and reject clipped or covered lines.
 * @param page - assembled application page with an explicit viewport.
 * @param content - the user-scrollable element containing the recorded text or highlighted source.
 * @param text - a contiguous instruction excerpt, including text split across highlighting spans.
 * @param label - assertion context identifying the instruction witness.
 */
export async function expectSkillTextReadable(page: Page, content: Locator, text: string, label: string): Promise<void> {
  await content.waitFor({ state: 'visible' })
  const instruction = await content.evaluateHandle((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes: Node[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes.push(node)
    }
    const start = nodes.map(node => node.textContent).join('').indexOf(text)
    if (start < 0) throw new Error('Skill instruction excerpt is missing')
    const range = document.createRange()
    let offset = 0
    for (const node of nodes) {
      const end = offset + node.textContent!.length
      if (start >= offset && start < end) range.setStart(node, start - offset)
      if (start + text.length > offset && start + text.length <= end) {
        range.setEnd(node, start + text.length - offset)
        break
      }
      offset = end
    }
    // Position the excerpt within each scrollport before moving that scrollport's ancestor.
    for (let ancestor: Element | null = element; ancestor !== null; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      if (!/^(auto|scroll)$/.test(style.overflowY) || ancestor.scrollHeight <= ancestor.clientHeight) continue
      const top = ancestor.getBoundingClientRect().top + ancestor.clientTop
      const composerOverlap = ancestor.hasAttribute('data-conversation-scroll')
        ? Number.parseFloat(style.getPropertyValue('--dsh-composer-overlap-height')) || 0
        : 0
      const bounds = range.getBoundingClientRect()
      ancestor.scrollTop += bounds.top - top - Math.max(0, (ancestor.clientHeight - composerOverlap - bounds.height) / 2)
    }
    return range
  }, text)
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
      requestAnimationFrame(() => { resolve() })
    })))
    const reading = await instruction.evaluate((range) => {
      const owner = range.commonAncestorContainer.parentElement!
      return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map((rect) => {
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight
        for (let node: Element | null = owner; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node), clip = node.getBoundingClientRect()
          if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
            left = Math.max(left, clip.left); right = Math.min(right, clip.right)
          }
          if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
            top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
          }
        }
        return {
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible: rect.left >= left - 1 && rect.right <= right + 1
            && rect.top >= top - 1 && rect.bottom <= bottom + 1,
          uncovered: [.1, .5, .9].every(position => owner.contains(document.elementFromPoint(
            rect.left + rect.width * position, rect.top + rect.height / 2,
          ))),
        }
      })
    })
    expect(reading.length, `${label}: text has rendered line boxes`).toBeGreaterThan(0)
    expect(reading.every(line => line.visible && line.uncovered), `${label}: ${JSON.stringify(reading)}`).toBe(true)
  } finally {
    await instruction.dispose()
  }
}
