// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-documents host half', () => {
  it('is a no-op stub that exists only for Loader roster discovery', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
