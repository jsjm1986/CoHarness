/**
 * Static sizing and token checks for the centered dock strip. Browser
 * fixtures own rendered clearance, touch targets, and control reachability.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sheetCss = readFileSync(fileURLToPath(new URL('../src/components/dockkit.module.css', import.meta.url)), 'utf8')

/** The sheet's unconditional layer: `@media` blocks removed with their balanced braces. */
function stripMediaBlocks(css: string): string {
  let result = ''
  let i = 0
  while (i < css.length) {
    const at = css.indexOf('@media', i)
    if (at === -1) return result + css.slice(i)
    result += css.slice(i, at)
    const open = css.indexOf('{', at)
    let depth = 0
    let end = open
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    i = end + 1
  }
  return result
}

/** Declarations of every unconditional rule whose selector list contains `selector`, merged in source order. */
function declarationsFor(selector: string): Map<string, string> {
  const declarations = new Map<string, string>()
  const withoutComments = stripMediaBlocks(sheetCss.replace(/\/\*[\s\S]*?\*\//g, ' '))
  for (const [, selectors = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').map(part => part.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
    }
  }
  return declarations
}

describe('dock strip segmented-bar language', () => {
  it('wraps the chips in the hover-fill track with the card corner and 3px padding', () => {
    const track = declarationsFor('.stripTabs')
    expect(track.get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
    expect(track.get('border-radius')).toBe('var(--dsw-radius-card)')
    expect(track.get('padding')).toBe('3px')
  })

  it('centers the track with equal block padding and a 50px minimum band', () => {
    const strip = declarationsFor('.tabStrip')
    expect(strip.get('box-sizing')).toBe('border-box')
    expect(strip.get('align-items')).toBe('center')
    expect(strip.get('height')).toBe('max(var(--dsh-dockkit-strip-block, 50px), 50px)')
    expect(strip.get('padding')).toBe('8px 6px 8px var(--dsh-dockkit-strip-inline-start, 10px)')
  })

  it('sets chips as 24px segments in the bar type', () => {
    const chip = declarationsFor('.tab')
    expect(chip.get('height')).toBe('24px')
    expect(chip.get('border-radius')).toBe('var(--dsw-radius-control)')
    expect(chip.get('font-weight')).toBe('500')
    expect(chip.get('letter-spacing')).toBe('-0.01em')
  })

  it('raises the active chip and the lone label as the bar pill', () => {
    for (const selector of ['.tabActive', '.tabActive:hover', '.tab.tabQuiet', '.tab.tabQuiet:hover']) {
      const pill = declarationsFor(selector)
      expect(pill.get('background'), selector).toBe('var(--dsw-alias-bg-raised)')
      expect(pill.get('box-shadow'), selector).toBe('var(--dsw-elevation-control)')
      expect(pill.get('--dsw-elevation-stroke-color'), selector).toBe('var(--dsw-alias-border-l3)')
    }
    // The retired look was the flat markdown-tag fill.
    expect(sheetCss).not.toMatch(/\.tabActive[^{]*\{[^}]*markdown-tag/)
  })

  it('separates chips by the slot gap, not a hairline', () => {
    const withoutComments = sheetCss.replace(/\/\*[\s\S]*?\*\//g, ' ')
    expect(withoutComments).not.toMatch(/\.slot::before/)
    const caret = declarationsFor('.slotCaret::before')
    expect(caret.get('width')).toBe('2px')
    expect(caret.get('background')).toBe('var(--dsw-alias-brand-primary-new-colorprimary-new-color)')
  })

  it('draws the header hairline under the strip on the host header box', () => {
    expect(declarationsFor('.tabHostHeader').get('border-bottom')).toBe('0.5px solid var(--dsw-alias-border-l3)')
  })
})
