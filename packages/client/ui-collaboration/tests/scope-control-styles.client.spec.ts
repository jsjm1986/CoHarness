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

  it('flattens the trigger into the footer row grammar on phones', () => {
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.context,[\s\S]*\.contextSteward\s*\{[^}]*box-shadow:\s*none/)
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.mode:not\(\.modeSteward\)\s*\{[^}]*display:\s*none/)
  })

  it('renders the phone roster as an in-column accordion: indented hairline rows, bounded height', () => {
    // The accordion is zero-overlay: no card surface, shadow, or popover
    // positioning — just indented rows under the head inside the footer column.
    const list = css.match(/\.inlineList\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(list).toContain('display: flex')
    expect(list).toContain('flex-direction: column')
    expect(list).toContain('overflow-y: auto')
    expect(list).toContain('max-height: min(320px')
    expect(list).toContain('margin: 0 -2px')
    expect(list).toContain('border-top: 0.5px solid var(--dsw-alias-border-l2)')
    expect(css).toMatch(/\.inlineList > \* \+ \*\s*\{[^}]*border-top:\s*0\.5px solid var\(--dsw-alias-border-l2\)/)
    // The expanded group reads as one zone: a tonal band closed by hairlines.
    expect(list).toContain('border-bottom: 0.5px solid var(--dsw-alias-border-l2)')
    expect(list).toMatch(/background:\s*color-mix\(in srgb, var\(--dsw-alias-interactive-bg-hover\)/)
    const row = css.match(/\.inlineRow\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(row).toContain('min-height: var(--dsw-touch-target)')
    expect(row).toContain('0 var(--dsw-space-2) 0 26px')
    // The current scope is the single primary row: brand-blue tint and label.
    const current = css.match(/\.inlineRowCurrent[^{]*\{([^}]*)\}/)?.[1] ?? ''
    expect(current).toMatch(/background:\s*color-mix\(in srgb, var\(--dsw-alias-state-business-primary\)/)
    expect(current).toContain('color: var(--dsw-alias-state-business-primary)')
  })

  it('caps the project menu and keeps its search controls tappable on phones', () => {
    expect(css).toMatch(/\.scopeMenu\s*\{[^}]*--dsh-menu-max-height:\s*min\(480px,\s*calc\(100vh - 24px\)\)/)
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.menuSearch\s*\{[^}]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(css).toMatch(/\.menuSearchClear\s*\{[^}]*width:\s*24px/)
  })

  it('takes over the footer column as a transparent in-flow hub, not a card', () => {
    // Doubled selectors keep the overrides ahead of Menu's .root/.list.
    expect(css).toMatch(/\.scopeField\.scopeField\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/)
    const sheet = css.match(/\.scopeSheet\.scopeSheet\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(sheet).toContain('order: -1')
    expect(sheet).toContain('position: static')
    expect(sheet).toContain('box-shadow: none')
    expect(sheet).toContain('--dsw-menu-surface-fill: transparent')
    expect(sheet).toContain('--dsh-menu-max-height: min(560px, calc(100vh - 150px))')
  })

  it('carries the hub blocks on the footer surface: card, radio track, warn row', () => {
    // The current-space card is a sibling of the trigger, not a raised panel.
    const card = css.match(/\.currentCard\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(card).toContain('background: var(--dsw-alias-bg-layer-2)')
    expect(card).toContain('box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2)')
    // Visibility radio mirrors the conversation header's sliding-pill segment.
    const seg = css.match(/\.visSeg\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(seg).toContain('grid-template-columns: 1fr 1fr')
    expect(seg).toContain('background: var(--dsw-alias-interactive-bg-hover)')
    const pill = css.match(/\.visSeg::before\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(pill).toContain('background: var(--dsw-alias-bg-raised)')
    expect(pill).toContain('transform: translateX(calc(var(--dsh-vis-index, 0) * 100%))')
    // A pending-invitation row joins the steward caution family.
    expect(css).toMatch(/\.invRowWarn[^{]*\{[^}]*background:\s*var\(--dsw-alias-state-warn-tertiary\)/)
  })

  it('gives every scope row a deterministic identity tile', () => {
    expect(css).toMatch(/\.tile\s*\{[^}]*width:\s*20px[^}]*border-radius:\s*var\(--dsw-radius-sm\)/)
    for (const tone of ['tileBlue', 'tileGreen', 'tileAmber', 'tileRed', 'tileDeep', 'tileWarn']) {
      expect(css).toContain(`.${tone}`)
    }
  })
})
