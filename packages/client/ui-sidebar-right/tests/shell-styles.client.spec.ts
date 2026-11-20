/**
 * Static checks for the Sidebar's preferred desktop strip height and
 * clipping rules. Dockkit owns centered padding and the touch height floor.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sheetCss = readFileSync(
  fileURLToPath(new URL('../src/client/shell/SidebarRight.module.css', import.meta.url)),
  'utf8',
)

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

describe('sidebar shell header contract', () => {
  it('publishes a preferred 52px desktop strip band', () => {
    const panel = declarationsFor('.panel')
    expect(panel.get('--dsh-dockkit-strip-block')).toBe('52px')
  })

  it('clips the push presentation body to the card corners without trapping floats', () => {
    const body = declarationsFor(".panel[data-sidebar-right-panel='push'] .panelBody")
    expect(body.get('overflow')).toBe('clip')
    expect(body.get('border-radius')).toBe('inherit')
  })

  it('lifts the strip controls to the compact row target under 768px', () => {
    // The last `.iconButton` declaration wins: the compact block redeclares it.
    const compact = declarationsFor('.iconButton')
    expect(compact.get('width')).toBe('36px')
    expect(compact.get('height')).toBe('36px')
  })
})
