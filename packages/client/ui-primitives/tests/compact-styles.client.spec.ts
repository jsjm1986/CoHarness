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
})
