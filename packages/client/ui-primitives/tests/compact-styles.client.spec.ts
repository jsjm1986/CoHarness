/**
 * Compact primitive stylesheet contract, asserted against the CSS text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Read a stylesheet next to this spec.
 * @param rel - path relative to this file.
 * @returns file text.
 */
function load(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

describe('primitive compact chrome', () => {
  it('caps HoverCard width and lifts Toast below the safe top under 768px', () => {
    const hover = load('../src/HoverCard.module.css')
    const toast = load('../src/Toast.module.css')
    expect(hover).toContain('@media (max-width: 767px)')
    expect(hover).toContain('calc(100vw - 24px)')
    expect(toast).toContain('@media (max-width: 767px)')
    expect(toast).toContain('--dsw-safe-top')
    expect(load('../src/markdown/CodeBlock.module.css')).toContain('min-height: var(--dsw-touch-target)')
  })

  it('lets compact disclosure rows wrap and grow the leading control', () => {
    const disclosure = load('../src/DisclosureRow.module.css')
    expect(disclosure).toContain("[data-viewport='compact']")
    expect(disclosure).toContain('flex-wrap: wrap')
    expect(disclosure).toContain('var(--dsw-touch-target)')
  })

  it('presents portaled menus as safe-area phone sheets', () => {
    const menu = load('../src/Menu.module.css')
    const backdrop = load('../src/MobileSheetBackdrop.module.css')
    expect(menu).toContain('bottom sheet gives every row')
    expect(menu).toContain('var(--dsw-mobile-sheet-bottom)')
    expect(menu).toContain('var(--dsw-mobile-sheet-max-height)')
    expect(menu).toContain('!important')
    expect(menu).toContain('.list.scrollable')
    expect(menu).toContain('overflow: hidden')
    expect(menu).toContain('.list.scrollable .viewport')
    expect(backdrop).toContain('@media (max-width: 767px)')
    expect(backdrop).toContain('z-index: 1090')
    expect(backdrop).toContain('animation: none')
  })

  it('keeps modal sheets scrollable, elevated, and animated consistently', () => {
    const modal = load('../src/Modal.module.css')
    expect(modal).toContain('mobile-modal-sheet-in')
    expect(modal).toContain('--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)')
    expect(modal).toContain('var(--dsw-safe-bottom)')
  })

  it('tightens markdown reading rhythm on compact viewports', () => {
    const markdown = load('../src/markdown/MarkdownText.module.css')
    expect(markdown).toContain("[data-viewport='compact']")
    expect(markdown).toContain('font: var(--dsw-mobile-font-body)')
    expect(markdown).toContain('font: 600 18px/26px var(--dsw-font-family)')
    expect(markdown).toContain('margin: var(--dsw-space-2) 0')
  })

  it('keeps code and tool-result card chrome compact without shrinking tap targets', () => {
    const cards = [
      load('../src/markdown/CodeBlock.module.css'),
      load('../src/ReadBlock.module.css'),
      load('../src/SearchBlock.module.css'),
      load('../src/TerminalBlock.module.css'),
      load('../src/DiffBlock.module.css'),
    ]
    for (const css of cards) {
      expect(css).toContain('@media (max-width: 767px)')
      expect(css).toContain('min-height: var(--dsw-touch-target)')
      expect(css).toContain('padding: 0 10px')
    }
  })

  it('tightens non-copy result surfaces on compact viewports too', () => {
    expect(load('../src/WebBlock.module.css')).toContain('max-height: min(240px, 45vh)')
    expect(load('../src/markdown/JsonBlock.module.css')).toContain('max-height: min(200px, 40vh)')
  })
})
