/**
 * AppFrame stylesheet contract, asserted against the CSS text on disk. The
 * details resize strip is positioned by inline `left` at the track edge and
 * corrected by these rules: the floating panel's 8px inset puts its left
 * border one inset left of the track edge, and the strip must stack above the
 * dock layer and the overlay scrim to stay hittable. jsdom cannot hit-test,
 * so the hit-strip geometry and layering live here as text contracts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sheetCss = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')

/** Declarations of every rule whose selector list contains `selector`, merged in source order. */
function declarationsFor(selector: string): Map<string, string> {
  const declarations = new Map<string, string>()
  const withoutComments = sheetCss.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectors = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').map(part => part.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
    }
  }
  return declarations
}

describe('AppFrame details drag strip', () => {
  it('centers the strip on the panel border, not the track edge', () => {
    // The details column floats one --dsw-space-2 inset inside the track's
    // right edge; without this correction the strip sits inside the panel box.
    const declarations = declarationsFor(".frame:not([data-viewport='compact']) .handle[data-side='details']")
    expect(declarations.get('translate')).toBe('calc(0px - var(--dsw-space-2)) 0')
  })

  it('keeps the handle above the dock layer and the overlay scrim', () => {
    // The strip straddles the panel's left border, where dockkit cells
    // (--dsh-dockkit-dock-layer: 10) and an open medium scrim (14) would
    // otherwise take every pointer event.
    expect(Number.parseInt(declarationsFor('.handle').get('z-index') ?? '', 10)).toBe(15)
    expect(declarationsFor('.scrim').get('z-index')).toBe('14')
  })

  it('lifts the medium overlay column above its scrim', () => {
    expect(declarationsFor(".frame[data-viewport='medium'] .detailsCol").get('z-index')).toBe('15')
  })
})
