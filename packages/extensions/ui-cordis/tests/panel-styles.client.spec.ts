/** Cordis panel footer-row stylesheet contract, asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/CordisPanel.module.css', import.meta.url)), 'utf8')

describe('CordisPanel.module.css', () => {
  it('grows the wide badge to the touch target on compact viewports', () => {
    expect(css).toContain("[data-viewport='compact']")
    expect(css).toContain('.layer:not(.rail) .badge')
    expect(css).toContain('min-height: var(--dsw-touch-target)')
  })

  it('lets the plugin label shrink before the running count', () => {
    expect(css).toMatch(/\.badgeLabel\s*\{[^}]*flex:\s*1 1 auto/)
    expect(css).toMatch(/\.badgeCount\s*\{[^}]*flex:\s*none/)
  })
})
