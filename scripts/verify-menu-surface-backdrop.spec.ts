/** Menu-surface backdrop pairing: repository inventory and detection boundary. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { menuSurfaceBackdropViolations } from './verify-menu-surface-backdrop.ts'

const cleanups: string[] = []

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-menu-surface-backdrop-'))
  cleanups.push(root)
  return root
}

function write(root: string, path: string, content: string): void {
  const target = resolve(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

const COMPLIANT = `.menu {
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  box-shadow: var(--dsw-elevation-prominent);
}`

describe('menu surface backdrop pairing', () => {
  it('accepts the repository stylesheet inventory', async () => {
    expect(await menuSurfaceBackdropViolations(resolve(import.meta.dirname, '..'))).toEqual([])
  })

  it('rejects an elevated translucent surface without backdrop-filter', async () => {
    const root = fixture()
    write(root, 'packages/client/ui-demo/src/client/Foo.module.css', `${COMPLIANT}
.menu {
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
}`)

    expect(await menuSurfaceBackdropViolations(root)).toEqual([
      'packages/client/ui-demo/src/client/Foo.module.css: `.menu` pairs the translucent menu fill with an elevation shadow but no backdrop-filter',
    ])
  })

  it('rejects the surface through the menu-surface-fill alias as well', async () => {
    const root = fixture()
    write(root, 'packages/client/ui-demo/src/client/Bar.module.css', `${COMPLIANT}
.panel { background: var(--dsw-menu-surface-fill); box-shadow: var(--dsw-elevation-panel); }`)

    expect(await menuSurfaceBackdropViolations(root)).toEqual([
      'packages/client/ui-demo/src/client/Bar.module.css: `.panel` pairs the translucent menu fill with an elevation shadow but no backdrop-filter',
    ])
  })

  it('ignores fill-bearing elements that carry no elevation shadow', async () => {
    const root = fixture()
    write(root, 'packages/client/ui-demo/src/client/Badges.module.css', `${COMPLIANT}
.badge { background: var(--dsw-specific-menu); border-radius: 4px; }`)

    expect(await menuSurfaceBackdropViolations(root)).toEqual([])
  })
})
