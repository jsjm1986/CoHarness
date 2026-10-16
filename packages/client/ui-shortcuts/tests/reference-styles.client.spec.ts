/** Shortcut settings row stylesheet contract. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/Reference.module.css', import.meta.url)), 'utf8')

function compactBlock(): string {
  const match = css.match(/@media \(max-width: 767px\)\s*\{([\s\S]*?)\n\}/)
  if (match === null) throw new Error('stylesheet has no compact media block')
  return match[1]!
}

describe('Reference.module.css settings row', () => {
  it('keeps the desktop control a pill and hides the compact chevron', () => {
    expect(css).toMatch(/\.button\s*\{[\s\S]*border-radius:[\s\S]*background:/)
    expect(css).toMatch(/\.chevron\s*\{[\s\S]*display:\s*none/)
  })

  it('lays the row out as text plus a trailing accessory on the phone', () => {
    const compact = compactBlock()
    expect(compact).toMatch(/\.button\s*\{[\s\S]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(compact).toMatch(/\.button\s*\{[\s\S]*background:\s*transparent/)
    expect(compact).toMatch(/\.chevron\s*\{[\s\S]*display:\s*inline-flex/)
    expect(compact).toMatch(/\.setting\s*\{[\s\S]*padding:\s*var\(--dsw-space-3\) 0/)
  })
})
