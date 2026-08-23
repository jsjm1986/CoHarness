/**
 * Settings shell stylesheet contract, asserted against the CSS text on disk.
 * Compact rules live in a portaled overlay that never sees `data-viewport`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one top-level class rule.
 * @param selector - local class selector including the leading dot.
 * @returns the rule body.
 */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`SettingsRoot.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

/**
 * Inner text of one `@media` block, including nested rules.
 * @param query - the media condition, e.g. `(max-width: 767px)`.
 * @returns the block body.
 */
function mediaBody(query: string): string {
  const marker = `@media ${query}`
  const start = css.indexOf(marker)
  if (start === -1) throw new Error(`SettingsRoot.module.css has no @media ${query}`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`SettingsRoot.module.css @media ${query} is unbalanced`)
}

describe('SettingsRoot.module.css compact overlay', () => {
  it('lets the options column shrink so overflow-y can scroll', () => {
    expect(block('.content')).toContain('min-height: 0')
    expect(block('.options')).toContain('min-height: 0')
    expect(block('.options')).toContain('overflow-y: auto')
  })

  it('sizes the portaled overlay from the visual-viewport variable, not 100vh', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toContain('var(--dsw-viewport-height, 100dvh)')
    expect(compact).not.toMatch(/100vh/)
  })

  it('keeps the settings title visible and gives nav cells the touch target', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).not.toMatch(/\.navTitle\s*\{[^}]*display:\s*none/)
    expect(compact).toMatch(/\.navCell\s*\{[^}]*height:\s*var\(--dsw-touch-target\)/)
  })

  it('keeps the tab strip from becoming a second vertical scroller', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.navList\s*\{[^}]*overflow-y:\s*hidden/)
    expect(compact).toMatch(/\.options\s*\{[^}]*overscroll-behavior:\s*contain/)
  })

  it('signals horizontally scrollable tabs at the compact edge', () => {
    const compact = mediaBody('(max-width: 767px)')
    expect(compact).toMatch(/\.navList\s*\{[^}]*overscroll-behavior-x:\s*contain/)
    expect(compact).toMatch(/\.navList::after\s*\{[^}]*pointer-events:\s*none/)
    expect(compact).toMatch(/background:\s*linear-gradient\(to right, transparent, var\(--dsw-alias-bg-layer-2\)\)/)
  })

  it('gives the close control the touch target on coarse pointers', () => {
    const coarse = mediaBody('(pointer: coarse)')
    expect(coarse).toMatch(/\.close\s*\{[^}]*width:\s*var\(--dsw-touch-target\)/)
    expect(coarse).toMatch(/\.close\s*\{[^}]*height:\s*var\(--dsw-touch-target\)/)
  })
})
