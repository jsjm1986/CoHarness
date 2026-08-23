/** Logout footer stylesheet contract, asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/LogoutButton.module.css', import.meta.url)), 'utf8')

describe('LogoutButton.module.css', () => {
  it('uses the compact shared row and secondary default ink', () => {
    expect(css).toMatch(/\.trigger\s*\{[^}]*height:\s*var\(--dsh-sidebar-footer-row-height,\s*36px\)/)
    expect(css).toMatch(/\.trigger\s*\{[^}]*color:\s*var\(--dsw-alias-label-secondary\)/)
    expect(css).toMatch(
      new RegExp([
        String.raw`\.trigger:hover\s*\{[\s\S]*background:\s*`,
        String.raw`var\(--dsw-alias-interactive-bg-hover-danger\)`,
        String.raw`[\s\S]*color:\s*var\(--dsw-alias-label-danger\)`,
      ].join('')),
    )
    expect(css).toMatch(
      new RegExp([
        String.raw`\.trigger:focus-visible\s*\{[\s\S]*background:\s*`,
        String.raw`var\(--dsw-alias-interactive-bg-hover-danger\)`,
        String.raw`[\s\S]*color:\s*var\(--dsw-alias-label-danger\)`,
      ].join('')),
    )
  })

  it('keeps the rail hover neutral and the touch target intact', () => {
    expect(css).toMatch(/\.trigger\.rail\s*\{[^}]*width:\s*36px/)
    expect(css).toMatch(/\.trigger\.rail:hover\s*\{[\s\S]*background:\s*var\(--dsw-alias-interactive-bg-hover\)/)
    expect(css).toContain('min-height: var(--dsw-touch-target)')
  })
})
