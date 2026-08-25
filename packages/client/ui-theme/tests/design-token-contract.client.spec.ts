/**
 * Static design-token gate. Every `--ds-*`/`--dsw-*` reference in a shipped
 * stylesheet must resolve to a CSS declaration in the same source plane.
 * Values written by the runtime are the only intentional exceptions: they are
 * listed explicitly so a misspelled alias cannot silently fall back to the
 * browser default.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const RUNTIME_TOKENS = new Set([
  '--dsw-viewport-height',
])

function cssFiles(root: string): string[] {
  const result: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.css')) result.push(path)
    }
  }
  visit(root)
  return result
}

const source = cssFiles(PACKAGES_DIR).map(path => ({
  path,
  css: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '),
}))

const declared = new Set<string>()
const references = new Map<string, string[]>()
for (const { path, css } of source) {
  for (const match of css.matchAll(/(?:^|[;{]\s*)(--(?:ds|dsw)-[A-Za-z0-9_-]+)\s*:/gm)) {
    const token = match[1]
    if (token !== undefined) declared.add(token)
  }
  for (const match of css.matchAll(/var\(\s*(--(?:ds|dsw)-[A-Za-z0-9_-]+)\b/g)) {
    const token = match[1]
    if (token === undefined) continue
    const files = references.get(token) ?? []
    files.push(path)
    references.set(token, files)
  }
}

describe('design token references', () => {
  it('resolve every design-system variable or name an explicit runtime owner', () => {
    for (const [token, files] of references) {
      if (RUNTIME_TOKENS.has(token)) continue
      expect(declared, files.join(', ')).toContain(token)
    }
  })
})
