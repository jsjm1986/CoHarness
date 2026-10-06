import { describe, expect, it } from 'vitest'
import { formatCostInput, parseCostInput } from './money.ts'

const pairs: readonly { micros: number; text: string }[] = [
  { micros: 0, text: '0' },
  { micros: 1, text: '0.000001' },
  { micros: 7, text: '0.000007' },
  { micros: 8_500_000, text: '8.5' },
  { micros: 9_250_001, text: '9.250001' },
  { micros: 9_007_199_254_740_991, text: '9007199254.740991' },
]

describe('cost input helpers', () => {
  it.each(pairs)('formats $micros micros as $text', ({ micros, text }) => {
    expect(formatCostInput(micros)).toBe(text)
  })

  it.each(pairs)('parses $text back to $micros micros', ({ micros, text }) => {
    expect(parseCostInput(text)).toBe(micros)
    expect(formatCostInput(parseCostInput(text))).toBe(text)
  })

  it.each([
    { text: '0.0000004', micros: 0 },
    { text: '0.0000005', micros: 1 },
    { text: '0.9999995', micros: 1_000_000 },
  ])('rounds $text to $micros micros', ({ text, micros }) => {
    expect(parseCostInput(text)).toBe(micros)
  })

  it.each(['', '   ', '-1', 'NaN', '1e3', '9007199254.740992', '9007199254.7409915'])(
    'rejects %j',
    text => {
      expect(() => parseCostInput(text)).toThrow()
    },
  )
})
