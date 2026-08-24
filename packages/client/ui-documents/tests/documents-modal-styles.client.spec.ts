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

  it('separates filters from document actions and gives rows a stable hover rhythm', () => {
    expect(modal).toMatch(/\.filterGroup\s*,\s*\.actionGroup\s*\{[\s\S]*display:\s*flex/)
    expect(modal).toMatch(/\.filterGroup\s*\{[\s\S]*flex:\s*1 1 420px/)
    expect(modal).toMatch(/\.actionGroup\s*\{[\s\S]*margin-left:\s*auto/)
    expect(modal).toMatch(/\.row:hover\s*\{[\s\S]*background:\s*var\(--dsw-alias-interactive-bg-hover\)/)
    expect(modal).toMatch(/@media \(pointer: coarse\)[\s\S]*\.newFolder,[\s\S]*min-height:\s*var\(--dsw-touch-target\)/)
  })

  it('keeps the selected destructive action readable on its primary fill', () => {
    expect(modal).toMatch(/\.selectionDelete\s*\{[\s\S]*color:\s*var\(--dsw-alias-label-primary-foreground\)/)
  })

  it('gives alternate-scope actions a full compact toolbar track', () => {
    expect(modal).toMatch(/\.actionGroup \.sourceAction\s*\{[\s\S]*grid-column:\s*1 \/ -1/)
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
