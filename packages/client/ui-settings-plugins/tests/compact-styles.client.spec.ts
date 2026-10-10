/**
 * Compact plugin-form stylesheet contract, asserted against the CSS text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fields = readFileSync(fileURLToPath(new URL('../src/client/fields.module.css', import.meta.url)), 'utf8')

/**
 * Inner text of one `@media` block.
 * @param source - stylesheet text.
 * @param query - the media condition.
 * @returns the block body.
 */
function mediaBody(source: string, query: string): string {
  const marker = `@media ${query}`
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`stylesheet has no @media ${query}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`stylesheet @media ${query} is unbalanced`)
}

describe('plugin form compact styles', () => {
  it('makes plugin fields full width under 768px', () => {
    const compact = mediaBody(fields, '(max-width: 767px)')
    expect(compact).toContain('width: 100%')
  })
})
