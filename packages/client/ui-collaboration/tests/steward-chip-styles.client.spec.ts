/** StewardChip tool-row stylesheet contract, asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/StewardChip.module.css', import.meta.url)), 'utf8')

describe('StewardChip.module.css', () => {
  it('degrades inside the clip-first extension seat instead of slicing', () => {
    // The seat clips contributed items first on a short row: the label
    // ellipsizes toward zero, the icon never squishes, and the pill keeps an
    // icon-sized floor so the seat edge never cuts a glyph mid-stroke.
    expect(css).toMatch(/\.chip\s*\{[^}]*flex:\s*0 1 auto/)
    expect(css).toMatch(/\.chip\s*\{[^}]*min-width:\s*26px/)
    expect(css).toMatch(/\.chip\s*\{[^}]*overflow:\s*hidden/)
    expect(css).toMatch(/\.icon\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.label\s*\{[^}]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.label\s*\{[^}]*white-space:\s*nowrap/)
  })

  it('collapses to an icon seat on the composer narrow tiers', () => {
    // The chip joins the composer's shared collapse strategy: the anonymous
    // inline-size container step and the compact viewport both drop the label.
    const container = css.match(/@container\s*\(max-width:\s*480px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(container).toMatch(/\.chip\s*\{[^}]*justify-content:\s*center/)
    expect(container).toMatch(/\.label\s*\{[^}]*display:\s*none/)
    const compact = css.match(/:global\(\[data-viewport='compact'\]\)\s*\.chip\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(compact).toContain('var(--dsw-touch-target)')
    expect(css).toMatch(/:global\(\[data-viewport='compact'\]\)\s*\.label\s*\{[^}]*display:\s*none/)
  })
})
