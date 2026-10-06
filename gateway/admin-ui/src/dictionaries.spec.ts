/** Dictionary integrity gates: zh/en parity, placeholder alignment, and non-empty English values. */
import { describe, expect, it } from 'vitest'

interface CopyModule { zh: Record<string, string>; en: Record<string, string> }

const modules = {
  ...import.meta.glob<CopyModule>('./**/*.copy.ts', { eager: true }),
  ...import.meta.glob<CopyModule>('./plugins/locales.ts', { eager: true }),
}
const CJK = /[㐀-䶿一-鿿]/u
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1] ?? '').sort()

describe('copy dictionaries', () => {
  it('covers every surface', () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(20)
  })

  for (const [path, pair] of Object.entries(modules)) {
    describe(path, () => {
      it('keeps zh/en key parity', () => {
        expect(Object.keys(pair.en).sort()).toEqual(Object.keys(pair.zh).sort())
      })
      it('aligns {name} placeholders between zh and en', () => {
        for (const key of Object.keys(pair.zh)) {
          expect(placeholders(pair.en[key] ?? ''), `${key}`).toEqual(placeholders(pair.zh[key] ?? ''))
        }
      })
      it('has no empty or CJK-bearing English values', () => {
        for (const [key, value] of Object.entries(pair.en)) {
          expect(value, `${key}`).not.toBe('')
          expect(value, `${key}`).not.toMatch(CJK)
        }
      })
    })
  }
})
