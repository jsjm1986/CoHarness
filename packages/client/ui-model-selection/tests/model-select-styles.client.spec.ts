/** Model selector stylesheet contracts asserted against the CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelSelect.module.css', import.meta.url)), 'utf8')

describe('ModelSelect.module.css', () => {
  it('keeps the trigger inside the flex width assigned to its root', () => {
    expect(css).toMatch(/\.trigger\s*\{[^}]*\bwidth:\s*100%;/u)
  })
})
