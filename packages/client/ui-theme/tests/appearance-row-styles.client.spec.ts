/**
 * Compact appearance-row stylesheet contract, asserted against the CSS text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppearanceRow.module.css', import.meta.url)), 'utf8')

/**
 * Inner text of one `@media` block.
 * @param query - the media condition.
 * @returns the block body.
 */
function mediaBody(query: string): string {
  const marker = `@media ${query}`
  const start = css.indexOf(marker)
  if (start === -1) throw new Error(`AppearanceRow.module.css has no @media ${query}`)
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
  throw new Error(`AppearanceRow.module.css @media ${query} is unbalanced`)
}

describe('AppearanceRow.module.css compact', () => {
  it('keeps the three theme cubes on one row under 768px', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.cubeRow\s*\{[^}]*flex-wrap:\s*nowrap/)
    expect(compact).toContain('flex: 1 1 0')
    expect(compact).toContain('min-height: var(--dsw-touch-target)')
  })
})
