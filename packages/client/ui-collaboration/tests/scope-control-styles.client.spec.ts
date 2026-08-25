/** ScopeControl footer-row stylesheet contract, asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ScopeControl.module.css', import.meta.url)), 'utf8')

describe('ScopeControl.module.css', () => {
  it('uses the shared compact footer row and lets the name shrink first', () => {
    expect(css).toMatch(/\.trigger\s*\{[^}]*height:\s*var\(--dsh-sidebar-footer-row-height,\s*36px\)/)
    expect(css).toMatch(/\.trigger\s*\{[^}]*width:\s*calc\(100% \+ 4px\)/)
    expect(css).toMatch(/\.trigger\s*\{[^}]*margin:\s*0 -2px/)
    expect(css).toMatch(/\.label\s*\{[^}]*flex:\s*1 1 auto/)
    expect(css).toMatch(/\.label\s*\{[^}]*min-width:\s*0/)
    expect(css).toMatch(/\.label\s*\{[^}]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.mode\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.chevron\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.context\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-2\)/)
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

  it('caps the project menu and keeps its search controls tappable on phones', () => {
    expect(css).toMatch(/\.scopeMenu\s*\{[^}]*--dsh-menu-max-height:\s*min\(480px,\s*calc\(100vh - 24px\)\)/)
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.menuSearch\s*\{[^}]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(css).toMatch(/\.menuSearchClear\s*\{[^}]*width:\s*24px/)
  })
})
