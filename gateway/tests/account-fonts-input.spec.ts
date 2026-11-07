/** Font preference JSON accepts the product's six account-owned fields. */
import { describe, expect, it } from 'vitest'
import { normalizeAccountPreferenceMutation } from '../src/account-preferences.ts'

const sizes = [ ['fontSize', 10, 22], ['codeFontSize', 10, 16], ['terminalFontSize', 10, 20] ] as const
const families = ['textFontFamily', 'codeFontFamily', 'terminalFontFamily'] as const

describe('account font preference input', () => {
  it.each(sizes)('normalizes %s at both supported limits and permits reset', (field, min, max) => {
    for (const value of [min, max, String(max)]) {
      expect(normalizeAccountPreferenceMutation({ namespace: 'ui-theme', field, operation: 'set', value, expectedRevision: 3 }))
        .toEqual({ namespace: 'ui-theme', field, operation: 'set', value: Number(value), expectedRevision: 3 })
    }
    expect(normalizeAccountPreferenceMutation({ namespace: 'ui-theme', field, operation: 'unset' }))
      .toEqual({ namespace: 'ui-theme', field, operation: 'unset' })
  })
  it.each(families)('accepts %s including the explicit built-in-font override', field => {
    for (const value of ['', '"Noto Sans", sans-serif']) {
      expect(normalizeAccountPreferenceMutation({ namespace: 'ui-theme', field, operation: 'set', value }))
        .toEqual({ namespace: 'ui-theme', field, operation: 'set', value })
    }
  })
  it.each(sizes)('rejects invalid %s without widening another namespace', (field, min, max) => {
    for (const value of [min - 1, max + 1, min + 0.5, null, true, {}, [], 'invalid', '', Infinity, NaN]) {
      expect(() => normalizeAccountPreferenceMutation({ namespace: 'ui-theme', field, operation: 'set', value })).toThrow()
    }
    expect(() => normalizeAccountPreferenceMutation({ namespace: 'locale', field, operation: 'set', value: min })).toThrow()
  })
  it.each(families)('rejects non-string %s', field => {
    for (const value of [null, true, 12, {}, []]) {
      expect(() => normalizeAccountPreferenceMutation({ namespace: 'ui-theme', field, operation: 'set', value })).toThrow()
    }
  })
})
