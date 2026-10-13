/**
 * Dock strip stylesheet contract, asserted against dockkit.module.css on
 * disk. The strip speaks the segmented-bar language of the conversation
 * header: a hover-fill track with the card corner and 3px padding, 24px
 * segments in the bar's 500/-0.01em type, the selected chip raised on
 * control elevation, and one header hairline under the row. jsdom cannot
 * render, so the visual contract lives here as text assertions.
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

  it('keeps the 38px row with the 30px band on 8px top margin', () => {
    const strip = declarationsFor('.tabStrip')
    expect(strip.get('height')).toBe('30px')
    // The band's insets are published variables with the design's own
    // fallbacks: a host beside a taller header raises the block total and
    // the content's top inset so both header rules draw on one line.
    expect(strip.get('padding')).toBe(
      'var(--dsh-dockkit-strip-block-start, 8px) 6px\n    calc(var(--dsh-dockkit-strip-block, 38px) - var(--dsh-dockkit-strip-block-start, 8px) - 30px)\n    var(--dsh-dockkit-strip-inline-start, 10px)',
    )
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
