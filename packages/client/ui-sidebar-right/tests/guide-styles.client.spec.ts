/**
 * Compact guide stylesheet contract, asserted against GuideBody.module.css on
 * disk: on a phone the guide's entries are the pushed panel's whole content,
 * so they take the flat-list grammar — top-anchored full-width rows split by
 * hairlines on the cell wrapper — rather than capsules floating in a centred
 * column.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sheet = readFileSync(
  fileURLToPath(new URL('../src/client/tabs/guide/GuideBody.module.css', import.meta.url)),
  'utf8',
)

/** Inner text of one `@media` block. */
function mediaBody(query: string): string {
  const marker = `@media ${query}`
  const start = sheet.indexOf(marker)
  if (start === -1) throw new Error(`stylesheet has no @media ${query}`)
  const open = sheet.indexOf('{', start)
  let depth = 0
  for (let i = open; i < sheet.length; i += 1) {
    const ch = sheet[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return sheet.slice(open + 1, i)
    }
  }
  throw new Error(`stylesheet @media ${query} is unbalanced`)
}

describe('guide compact styles', () => {
  it('top-anchors the column and drops the lift spacer', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.guide\s*\{[^}]*justify-content:\s*flex-start/)
    expect(compact).toMatch(/\.guide::after\s*\{[^}]*display:\s*none/)
  })

  it('renders entries as continuous hairline rows on their cell wrapper', () => {
    const compact = mediaBody('(max-width: 767px)')
    // The separator lives on `.entryCell`, not `.entry`: slot-provided entries
    // draw their own element inside the cell, so a class-keyed rule would miss
    // them.
    expect(compact).toMatch(/\.entryCell:not\(:last-child\)\s*\{[^}]*border-bottom:\s*0\.5px solid var\(--dsw-alias-border-l2\)/)
    expect(compact).toMatch(/\.entry\s*\{[^}]*border:\s*none[^}]*border-radius:\s*0/)
    expect(compact).toMatch(/\.entry\s*\{[^}]*background:\s*transparent/)
    expect(compact).toMatch(/\.entry\s*\{[^}]*width:\s*100%/)
  })
})
