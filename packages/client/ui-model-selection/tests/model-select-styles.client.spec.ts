/** Model selector stylesheet contracts asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelSelect.module.css', import.meta.url)), 'utf8')

describe('ModelSelect.module.css', () => {
  it('keeps the trigger inside the flex width assigned to its root', () => {
    expect(css).toMatch(/\.trigger\s*\{[^}]*\bwidth:\s*100%;/u)
  })

  it('uses the compact option-row contract inside the shared settings sheet', () => {
    expect(css).toContain('min-height: var(--dsw-mobile-option-row-height)')
    expect(css).toContain(".sectionContent .option[aria-checked='true']")
    expect(css).toContain('font-size: 11px')
  })

  it('collapses the trigger to its glyph inside a narrow composer row', () => {
    expect(css).toMatch(/\.triggerGlyph\s*\{[^}]*display:\s*none/u)
    const tier = css.match(/@container\s*\(max-width:\s*480px\)\s*\{(?<body>[^@]*)\}/u)?.groups?.body ?? ''
    expect(tier).toMatch(/\.triggerLabel,\s*\.triggerEffort\s*\{[^}]*display:\s*none/u)
    expect(tier).toMatch(/\.triggerGlyph\s*\{[^}]*display:\s*inline-flex/u)
  })

  it('collapses the trigger to its glyph on the compact phone row', () => {
    const scope = String.raw`:global\(\[data-viewport='compact'\]\)\s*\.`
    expect(css).toMatch(new RegExp(`${scope}triggerLabel,\\s*${scope}triggerEffort,\\s*${scope}chevron\\s*\\{[^}]*display:\\s*none`, 'u'))
    expect(css).toMatch(new RegExp(`${scope}triggerGlyph\\s*\\{[^}]*display:\\s*inline-flex`, 'u'))
  })
})
