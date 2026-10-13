/**
 * Compact agent-preset stylesheet contract, asserted against the CSS text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const section = readFileSync(fileURLToPath(new URL('../src/client/AgentPresetSection.module.css', import.meta.url)), 'utf8')
const row = readFileSync(fileURLToPath(new URL('../src/client/AgentPresetRow.module.css', import.meta.url)), 'utf8')

/**
 * Inner text of one `@media` block.
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

describe('agent-preset compact styles', () => {
  it('gives preset card pickers the touch target under 768px', () => {
    const compact = mediaBody(section, '(max-width: 767px)')
    expect(compact).toContain('min-height: var(--dsw-touch-target)')
    expect(compact).toContain('grid-auto-rows: auto')
    expect(compact).toContain('grid-template-columns: minmax(0, 1fr)')
  })

  it('lists presets as continuous hairline rows, not cards, under 768px', () => {
    const compact = mediaBody(section, '(max-width: 767px)')
    expect(compact).toMatch(/\.card\s*\{[^}]*border:\s*0[^}]*border-bottom:\s*0\.5px solid var\(--dsw-alias-border-l2\)/)
    expect(compact).toMatch(/\.card\s*\{[^}]*border-radius:\s*0/)
    // Selection reads by fill alone on the flat list, not by a second box.
    expect(compact).toMatch(/\.cardActive\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\)/)
    expect(compact).toMatch(/\.cardFoot\s*\{[^}]*border-top:\s*0/)
  })

  it('keeps the general-settings preset row on one line under 768px', () => {
    const compact = mediaBody(row, '(max-width: 767px)')
    expect(compact).not.toContain('flex-direction: column')
    expect(compact).toContain('align-self: center')
    expect(compact).toContain('min-height: var(--dsw-touch-target)')
  })

  it('gives the hero preset chip the touch target on compact viewports', () => {
    const seat = readFileSync(fileURLToPath(new URL('../src/client/AgentPresetSeat.module.css', import.meta.url)), 'utf8')
    expect(seat).toContain("[data-viewport='compact']")
    expect(seat).toContain('min-height: var(--dsw-touch-target)')
    expect(seat).toContain('max-width: none')
  })

  it('keeps the session-header preset suffix a text-weight hairline unit', () => {
    const label = readFileSync(fileURLToPath(new URL('../src/client/AgentPresetLabel.module.css', import.meta.url)), 'utf8')
    // The suffix reads as part of the title sentence: a hairline separates it
    // from the breadcrumb strip, with no fill and no border box of its own.
    expect(label).toContain('border-left: 0.5px solid var(--dsw-alias-border-l2)')
    expect(label).toContain('color: var(--dsw-alias-label-tertiary)')
    expect(label).not.toContain('background')
    expect(label).not.toContain('border-radius')
  })
})
