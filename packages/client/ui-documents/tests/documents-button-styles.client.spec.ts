/** Documents footer-row stylesheet contract, asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/DocumentsButton.module.css', import.meta.url)), 'utf8')

describe('DocumentsButton.module.css', () => {
  it('uses the shared compact footer row', () => {
    expect(css).toMatch(/\.trigger\s*\{[^}]*height:\s*var\(--dsh-sidebar-footer-row-height,\s*36px\)/)
    expect(css).toMatch(/\.trigger\s*\{[^}]*width:\s*calc\(100% \+ 4px\)/)
    expect(css).toMatch(/\.trigger\s*\{[^}]*margin:\s*0 -2px/)
    expect(css).toMatch(/\.trigger\s*\{[^}]*text-align:\s*left/)
    expect(css).toMatch(/\.label\s*\{[^}]*flex:\s*1 1 auto/)
    expect(css).toMatch(/\.label\s*\{[^}]*min-width:\s*0/)
  })

  it('uses a 36px rail circle when the sidebar is collapsed', () => {
    expect(css).toMatch(/\.trigger\.rail\s*\{[^}]*width:\s*36px/)
    expect(css).toMatch(/\.trigger\.rail\s*\{[^}]*height:\s*36px/)
    expect(css).toMatch(/\.trigger\.rail\s*\{[^}]*border-radius:\s*50%/)
    expect(css).toMatch(/\.trigger\.rail\s*\{[^}]*margin:\s*0/)
  })

  it('grows the wide trigger to the touch target on compact viewports', () => {
    expect(css).toContain("[data-viewport='compact']")
    expect(css).toContain('.trigger:not(.rail)')
    expect(css).toContain('min-height: var(--dsw-touch-target)')
  })
})
