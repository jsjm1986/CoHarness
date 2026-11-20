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
  it('gives the touch row its full target height plus breathing room', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toContain('height: max(var(--dsh-dockkit-strip-block, 66px), 66px)')
    expect(sheet).toContain('padding: 8px 6px 8px var(--dsh-dockkit-strip-inline-start, 10px)')
  })

  it('lifts chips and controls to compact geometry under 768px', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.tab\s*\{[^}]*height:\s*44px/)
    expect(compact).toMatch(/\.tab\s*\{[^}]*min-width:\s*124px/)
    expect(compact).toMatch(/\.iconButton,\s*\.addTab\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/)
    expect(compact).toMatch(/\.tabClose\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/)
  })

  it('leaves the blocked split control\'s visibility to the kit, never the stylesheet', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).not.toMatch(/\[data-dockkit-split-blocked\][^}]*display:\s*none/)
  })

  it('keeps tab menu items at the touch target on phones and wider touchscreens', () => {
    const touch = mediaBody('(max-width: 767px), (pointer: coarse)')
    expect(touch).toMatch(/\.menuItem\s*\{[^}]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(touch).toMatch(/\.menu\s*\{[^}]*min-width:\s*160px/)
  })
})
