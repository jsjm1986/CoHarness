/**
 * Compact dockkit stylesheet contract, asserted against the CSS text: on a
 * phone the right sidebar's strip is the pushed panel's whole nav bar, so its
 * chips and controls leave the desktop's message-row geometry for the compact
 * family, and the long-press tab menu's items reach the shared touch target.
 * A width-blocked split control leaves the strip on phones too, but through
 * the kit's `hideSplitWhenBlocked` render path — never a stylesheet rule,
 * which would feed the freed footprint back into the room rule and spin the
 * measure loop (see `PaneMeasure.splitControlWidth` in engine/geometry).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sheet = readFileSync(resolve(import.meta.dirname, '../src/components/dockkit.module.css'), 'utf8')

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

describe('dockkit compact styles', () => {
  it('grows the strip row without growing the host band', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.tabStrip\s*\{[^}]*height:\s*40px/)
    // The 40px row comes out of the band's bottom padding, so the strip keeps
    // sharing the host's --dsh-dockkit-strip-block total.
    expect(compact).toContain('padding-bottom: calc(var(--dsh-dockkit-strip-block, 38px) - var(--dsh-dockkit-strip-block-start, 8px) - 40px)')
  })

  it('lifts chips and controls to compact geometry under 768px', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.tab\s*\{[^}]*height:\s*32px/)
    expect(compact).toMatch(/\.tab\s*\{[^}]*min-width:\s*88px/)
    expect(compact).toMatch(/\.iconButton,\s*\.addTab\s*\{[^}]*width:\s*36px[^}]*height:\s*36px/)
    expect(compact).toMatch(/\.tabClose\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/)
  })

  it('leaves the blocked split control\'s visibility to the kit, never the stylesheet', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).not.toMatch(/\[data-dockkit-split-blocked\][^}]*display:\s*none/)
  })

  it('gives the tab menu phone-sized items', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.menuItem\s*\{[^}]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(compact).toMatch(/\.menu\s*\{[^}]*min-width:\s*160px/)
  })
})
