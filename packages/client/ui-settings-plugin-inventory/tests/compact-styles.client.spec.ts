/**
 * Compact plugin-inventory stylesheet contract, asserted against the CSS text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/PluginInventorySettingsTab.module.css', import.meta.url)), 'utf8')

/**
 * Inner text of one at-rule block (`@media`/`@container`).
 * @param query - the full at-rule header, e.g. `@container plugin-inventory (max-width: 520px)`.
 * @returns the block body.
 */
function mediaBody(query: string): string {
  const start = css.indexOf(query)
  if (start === -1) throw new Error(`PluginInventorySettingsTab.module.css has no ${query}`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`PluginInventorySettingsTab.module.css @media ${query} is unbalanced`)
}

describe('PluginInventorySettingsTab.module.css compact', () => {
  it('collapses the cards grid to one column under 520px of inline size', () => {
    const compact = mediaBody('@container plugin-inventory (max-width: 520px)')
    expect(compact).toContain('grid-template-columns: minmax(0, 1fr)')
  })
})
