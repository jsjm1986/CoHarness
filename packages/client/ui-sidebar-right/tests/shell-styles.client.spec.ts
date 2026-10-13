/**
 * Sidebar shell stylesheet contract, asserted against
 * SidebarRight.module.css on disk. The panel publishes the docked strip's
 * band as the conversation header's 52px so the rules under both headers
 * draw on one line, and the panel body clips docked hosts to the card's
 * corners while floating panes still escape. jsdom cannot render, so the
 * contract lives here as text assertions.
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
  it("publishes the strip band as the conversation header's 52px", () => {
    const panel = declarationsFor('.panel')
    expect(panel.get('--dsh-dockkit-strip-block')).toBe('52px')
    expect(panel.get('--dsh-dockkit-strip-block-start')).toBe('var(--dsw-space-3)')
  })

  it('clips the push presentation body to the card corners without trapping floats', () => {
    const body = declarationsFor(".panel[data-sidebar-right-panel='push'] .panelBody")
    expect(body.get('overflow')).toBe('clip')
    expect(body.get('border-radius')).toBe('inherit')
  })
})
