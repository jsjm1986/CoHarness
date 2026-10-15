/** StewardChip tool-row stylesheet contract, asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/StewardChip.module.css', import.meta.url)), 'utf8')

describe('StewardChip.module.css', () => {
  it('renders binary states only — the seat never gets a truncated label', () => {
    // A partially clipped CJK label reads as a defect: the chip stays rigid
    // and jumps to its icon seat instead of shrinking or ellipsizing inside
    // the lane.
    expect(css).toMatch(/\.chip\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.icon\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.label\s*\{[^}]*white-space:\s*nowrap/)
    expect(css).not.toMatch(/\.label\s*\{[^}]*text-overflow/)
  })

  it('follows the lane clip signal rather than a guessed breakpoint', () => {
    // ExtensionItems publishes `data-clipped` while contributed content
    // overflows the clip-first lane; the chip drops to its icon seat on that
    // signal, so it never depends on fixed row content staying under a
    // hardcoded width.
    expect(css).not.toMatch(/@container/)
    expect(css).toMatch(/:global\(\[data-input-extension\]\[data-clipped\]\)\s*\.chip\s*\{[^}]*justify-content:\s*center/)
    // Label hiding under the clip flag is owned by the lane's shared
    // [data-clip-label] rule — the chip must not re-declare it.
    expect(css).not.toMatch(/data-clipped\]\)\s*\.label\s*\{[^}]*display:\s*none/)
    const compact = css.match(/:global\(\[data-viewport='compact'\]\)\s*\.chip\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(compact).toContain('var(--dsw-touch-target)')
    expect(css).toMatch(/:global\(\[data-viewport='compact'\]\)\s*\.label\s*\{[^}]*display:\s*none/)
  })
})
