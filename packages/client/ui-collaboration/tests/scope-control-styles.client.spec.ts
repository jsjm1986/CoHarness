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

  it('covers the sidebar column as a push page on wide surfaces', () => {
    // One rule serves both ends: the containing block is the compact drawer
    // on phones and the positioned sidebar column on wider layouts.
    const page = css.match(/\.scopePage\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(page).toContain('position: absolute')
    expect(page).toContain('inset: 0')
    expect(page).toContain('flex-direction: column')
    expect(page).toContain('background: var(--dsw-alias-bg-layer-1)')
    // The nav bar is pinned above the scrolling view.
    const nav = css.match(/\.pageNav\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(nav).toContain('flex: none')
    expect(nav).toContain('border-bottom: 0.5px solid var(--dsw-alias-border-l2)')
    expect(css).toMatch(/\.pageScroll\s*\{[^}]*overflow-y:\s*auto/)
    // The push reads as navigation: the page and its views slide in.
    expect(page).toContain('animation: scope-page-in')
    expect(css).toMatch(/@keyframes scope-page-in/)
    expect(css).toMatch(/\.pagePush\s*\{[^}]*animation:\s*scope-view-in/)
    expect(css).toMatch(/\.pagePop\s*\{[^}]*animation:\s*scope-view-out/)
  })

  it('lays the page rows as flat hairline leaves with one primary row', () => {
    // Rows are full-bleed buttons — no card surface inside the page; the
    // hairline lands only between neighbours, never above a group label.
    const row = css.match(/\.pageRow\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(row).toContain('border: 0')
    expect(row).toContain('min-height: 40px')
    expect(row).toContain('background: transparent')
    expect(css).toMatch(/\.pageRow \+ \.pageRow\s*\{[^}]*border-top:\s*0\.5px solid var\(--dsw-alias-border-l2\)/)
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*\.pageRow\s*\{[^}]*min-height:\s*var\(--dsw-touch-target\)/)
    // The current scope is the single primary row: brand-blue tint and label.
    const current = css.match(/\.pageRowCurrent[^{]*\{([^}]*)\}/)?.[1] ?? ''
    expect(current).toMatch(/background:\s*color-mix\(in srgb, var\(--dsw-alias-state-business-primary\)/)
    expect(current).toContain('color: var(--dsw-alias-state-business-primary)')
    // The settings group and roster carry their section labels.
    expect(css).toMatch(/\.pageGroup\s*\{[^}]*color:\s*var\(--dsw-alias-label-caption\)/)
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
