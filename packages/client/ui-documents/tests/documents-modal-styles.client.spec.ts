/** Document manager and preview dialog stylesheet contract. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modal = readFileSync(fileURLToPath(new URL('../src/client/DocumentsModal.module.css', import.meta.url)), 'utf8')
const preview = readFileSync(fileURLToPath(new URL('../src/client/DocumentPreview.module.css', import.meta.url)), 'utf8')
const sheet = readFileSync(fileURLToPath(new URL('../src/client/DocumentsMobileSheet.module.css', import.meta.url)), 'utf8')

function dialogBlock(source: string): string {
  const match = source.match(/\.dialog\s*\{[^}]*\}/)
  if (match === null) throw new Error('stylesheet has no .dialog block')
  return match[0]
}

describe('DocumentsModal.module.css', () => {
  it('uses the current wide workbench dimensions without stale fallback rules', () => {
    const block = dialogBlock(modal)
    expect(block).toContain('width: min(1180px, calc(100vw - 48px))')
    expect(block).toContain('min-height: min(680px, calc(var(--dsw-viewport-height, 100vh) - 40px))')
    expect(block).toContain('max-height: min(900px, calc(var(--dsw-viewport-height, 100vh) - 32px))')
    expect(block).not.toContain('960px')
  })

  it('keeps the compact dialog a full-width bottom sheet', () => {
    expect(modal).toMatch(/@media \(max-width: 767px\)[\s\S]*\.dialog\s*\{[\s\S]*width:\s*100%/)
    expect(modal).toMatch(/@media \(max-width: 767px\)[\s\S]*\.dialog\s*\{[\s\S]*min-height:\s*0/)
    expect(modal).toMatch(/\.dialog\.dialog\s*\{[\s\S]*box-sizing:\s*border-box/)
    expect(modal).toMatch(/@media \(max-width: 767px\)[\s\S]*\.dialog\.dialog\s*\{[\s\S]*height:\s*100%[\s\S]*max-height:\s*100%/)
  })

  it('separates filters from document actions and gives rows a stable hover rhythm', () => {
    expect(modal).toMatch(/\.filterGroup\s*,\s*\.actionGroup\s*\{[\s\S]*display:\s*flex/)
    expect(modal).toMatch(/\.filterGroup\s*\{[\s\S]*flex:\s*1 1 420px/)
    expect(modal).toMatch(/\.actionGroup\s*\{[\s\S]*margin-left:\s*auto/)
    expect(modal).toMatch(/\.row:hover\s*\{[\s\S]*background:\s*var\(--dsw-alias-interactive-bg-hover\)/)
    expect(modal).toMatch(/@media \(pointer: coarse\)[\s\S]*\.newFolder,[\s\S]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(modal).toMatch(/\.overviewActions\s*\{[\s\S]*display:\s*flex/)
    expect(modal).toMatch(/\.scopeNotice\s*\{[\s\S]*border:\s*1px solid/)
    expect(modal).toMatch(/\.scopePickerOption\s*\{[\s\S]*min-height:\s*52px/)
  })

  it('keeps the selected destructive action readable on its primary fill', () => {
    expect(modal).toMatch(/\.selectionDelete\s*\{[\s\S]*color:\s*var\(--dsw-alias-label-primary-foreground\)/)
  })

  it('gives compact upload and More controls one full toolbar track', () => {
    expect(modal).toMatch(/\.actionGroup\.mobileActionGroup\s*\{[\s\S]*display:\s*flex/)
    expect(modal).toMatch(/\.mobileActionGroup \.upload\s*\{[\s\S]*flex:\s*1 1 auto/)
  })

  it('keeps compact navigation and operations in touch-safe sheets', () => {
    expect(modal).toMatch(/\.scopeTrigger\s*\{[\s\S]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(modal).toMatch(/\.rowMore\s*\{[\s\S]*min-width:\s*var\(--dsw-touch-target\)[\s\S]*min-height:\s*var\(--dsw-touch-target\)/)
    expect(modal).toMatch(/\.mobileSelectionBar\s*\{[\s\S]*var\(--dsw-safe-bottom\)/)
    expect(modal).toMatch(/@media \(max-width: 767px\)[\s\S]*\.scopeRail\s*\{[\s\S]*display:\s*none/)
    expect(modal).toMatch(
      /\.row\s*\{[\s\S]*grid-template-columns:\s*var\(--dsw-touch-target\) 24px minmax\(0, 1fr\) var\(--dsw-touch-target\)/,
    )
    expect(modal).toContain('scrollbar-gutter: stable')
  })

  it('keeps limits and metadata in the shared mobile type roles', () => {
    expect(modal).toMatch(/\.limits\s*\{[\s\S]*font:\s*var\(--dsw-mobile-font-caption\)/)
    expect(modal).toMatch(/\.row \.name,[\s\S]*font:\s*var\(--dsw-mobile-font-body\)/)
    expect(modal).toMatch(/\.row \.size,[\s\S]*font:\s*var\(--dsw-mobile-font-caption\)/)
  })

  it('compresses desktop action labels in the narrow medium column', () => {
    expect(modal).toMatch(/@media \(min-width: 768px\) and \(max-width: 1023px\)[\s\S]*\.actions \.actionLabel\s*\{[\s\S]*display:\s*none/)
    expect(modal).toMatch(
      /@media \(min-width: 768px\) and \(max-width: 1023px\)[\s\S]*\.actions \.actionIcon\s*\{[\s\S]*display:\s*inline-flex/,
    )
  })
})

describe('DocumentsMobileSheet.module.css', () => {
  it('uses the shared inset sheet geometry and one body scrollport', () => {
    expect(sheet).toMatch(/\.dialog\.dialog\s*\{[\s\S]*overflow:\s*hidden/)
    expect(sheet).toMatch(/\.dialog\.dialog\s*\{[\s\S]*animation:\s*none/)
    expect(sheet).toMatch(/\.body\s*\{[\s\S]*overflow-y:\s*auto/)
    expect(sheet).toMatch(/var\(--dsw-mobile-sheet-bottom\)/)
    expect(sheet).toMatch(/var\(--dsw-safe-bottom\)/)
    expect(sheet).not.toContain('.handle')
    expect(sheet).toContain('scrollbar-gutter: stable')
  })
})

describe('DocumentPreview.module.css', () => {
  it('matches the manager desktop width and height', () => {
    const block = dialogBlock(preview)
    expect(block).toContain('width: min(960px, 100%)')
    expect(block).toContain('min-height: min(640px, calc(var(--dsw-viewport-height, 100vh) - 48px))')
    expect(block).toContain('max-height: min(860px, calc(var(--dsw-viewport-height, 100vh) - 48px))')
  })

  it('keeps preview content in one scrollport on compact surfaces', () => {
    expect(preview).toMatch(/\.body\s*\{[\s\S]*overflow:\s*auto[\s\S]*scrollbar-gutter:\s*stable/)
    expect(preview).toMatch(/\.text\s*\{[\s\S]*overflow:\s*visible/)
  })
})
