/** StewardChip tool-row stylesheet contract, asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/StewardChip.module.css', import.meta.url)), 'utf8')

describe('StewardChip.module.css', () => {
  it('renders binary states only — the seat never gets a truncated label', () => {
    // A partially clipped CJK label reads as a defect: the chip stays rigid
    // and jumps to its icon seat above the seat's clip point instead of
    // shrinking or ellipsizing inside it.
    expect(css).toMatch(/\.chip\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.icon\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.label\s*\{[^}]*white-space:\s*nowrap/)
    expect(css).not.toMatch(/\.label\s*\{[^}]*text-overflow/)
  })

  it('collapses to an icon seat ahead of the seat clip point', () => {
    // The steward row carries more fixed content than a plain row, so the
    // chip's own tier fires at 640px — before the ~560px of fixed row
    // content reaches the lane edge — and the compact viewport still drops
    // the label under the shared media tier.
    const container = css.match(/@container\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(container).toMatch(/\.chip\s*\{[^}]*justify-content:\s*center/)
    expect(container).toMatch(/\.label\s*\{[^}]*display:\s*none/)
    const compact = css.match(/:global\(\[data-viewport='compact'\]\)\s*\.chip\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(compact).toContain('var(--dsw-touch-target)')
    expect(css).toMatch(/:global\(\[data-viewport='compact'\]\)\s*\.label\s*\{[^}]*display:\s*none/)
  })
})
