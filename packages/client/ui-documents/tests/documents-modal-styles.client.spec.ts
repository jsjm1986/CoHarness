/** Document manager and preview dialog stylesheet contract. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modal = readFileSync(fileURLToPath(new URL('../src/client/DocumentsModal.module.css', import.meta.url)), 'utf8')
const preview = readFileSync(fileURLToPath(new URL('../src/client/DocumentPreview.module.css', import.meta.url)), 'utf8')

function dialogBlock(source: string): string {
  const match = source.match(/\.dialog\s*\{[^}]*\}/)
  if (match === null) throw new Error('stylesheet has no .dialog block')
  return match[0]
}

describe('DocumentsModal.module.css', () => {
  it('uses a 960px desktop card with a tall min and max height', () => {
    const block = dialogBlock(modal)
    expect(block).toContain('width: min(960px, 100%)')
    expect(block).toContain('min-height: min(640px, calc(100dvh - 48px))')
    expect(block).toContain('max-height: min(860px, calc(100dvh - 48px))')
  })

  it('keeps the compact dialog a full-width bottom sheet', () => {
    expect(modal).toMatch(/@media \(max-width: 767px\)[\s\S]*\.dialog\s*\{[\s\S]*width:\s*100%/)
    expect(modal).toMatch(/@media \(max-width: 767px\)[\s\S]*\.dialog\s*\{[\s\S]*min-height:\s*0/)
  })
})

describe('DocumentPreview.module.css', () => {
  it('matches the manager desktop width and height', () => {
    const block = dialogBlock(preview)
    expect(block).toContain('width: min(960px, 100%)')
    expect(block).toContain('min-height: min(640px, calc(100dvh - 48px))')
    expect(block).toContain('max-height: min(860px, calc(100dvh - 48px))')
  })
})
