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
    expect(css).toMatch(/\.modeFlag\s*\{[^}]*flex:\s*none/)
    expect(css).toMatch(/\.chevron\s*\{[^}]*flex:\s*none/)
  })

  it('renders mode flags as dot + text, never a filled pill', () => {
    // The flag is a status dot inherited from the flag colour plus text;
    // a background on either variant resurrects the boxed pill the page
    // grammar removed.
    const dots = css.match(/\.modeFlag::before,\s*\.scopeFlagMark::before,\s*\.scopeFlagWarn::before\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(dots).toContain('border-radius: 50%')
    expect(dots).toContain('currentcolor')
    for (const flag of ['.modeFlagWarn', '.scopeFlagWarn']) {
      const rule = css.match(new RegExp(`\\${flag}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
      expect(rule).toMatch(/var\(--dsw-alias-state-warn-(?:primary|label)\)/)
      expect(rule).not.toContain('background')
    }
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

  it('keeps page content scrollable within the shell-owned browsing region', () => {
    const page = css.match(/\.scopePage\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(page).toContain('position: absolute')
    expect(page).toContain('inset: 0')
    expect(page).toContain('min-height: 0')
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*\.scopePage\s*\{[^}]*top:\s*var\(--dsh-sidebar-region-top/)
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*\.scopePage\s*\{[^}]*height:\s*var\(--dsh-sidebar-region-height/)
    expect(css).toMatch(/\.pageScroll\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('caps the rail menu and keeps its search controls tappable on phones', () => {
    expect(css).toMatch(/\.scopeMenu\s*\{[^}]*--dsh-menu-max-height:\s*min\(480px,\s*calc\(100vh - 24px\)\)/)
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.menuSearch\s*\{[^}]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(css).toMatch(/\.menuSearchClear\s*\{[^}]*width:\s*24px/)
  })

  it('gives every scope row a deterministic identity tile', () => {
    expect(css).toMatch(/\.tile\s*\{[^}]*width:\s*20px[^}]*border-radius:\s*var\(--dsw-radius-sm\)/)
    for (const tone of ['tileBlue', 'tileGreen', 'tileAmber', 'tileRed', 'tileDeep', 'tileWarn']) {
      expect(css).toContain(`.${tone}`)
    }
  })
})
