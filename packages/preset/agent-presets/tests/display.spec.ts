import { describe, expect, it } from 'vitest'
import { presetDisplayName, presetDisplayText } from '../src/display.ts'

describe('presetDisplayName', () => {
  it('localizes known shipped ids and keeps user metadata literal', () => {
    const translate = (key: string): string => `translated:${key}`
    expect(presetDisplayName({ id: 'standard', trust: 'system', name: 'ignored' }, translate)).toBe('translated:presetStandardName')
    expect(presetDisplayName({ id: 'mine', trust: 'user', name: '我的模式' }, translate)).toBe('我的模式')
    expect(presetDisplayName({ id: 'unknown', trust: 'system' }, translate)).toBe('unknown')
    expect(presetDisplayText({ id: 'code', trust: 'system' }, translate)).toEqual({
      name: 'translated:presetCodeName', description: 'translated:presetCodeDescription',
    })
    expect(presetDisplayText({ id: 'mine-with-description', trust: 'user', name: 'Mine', description: 'Custom' }, translate))
      .toEqual({ name: 'Mine', description: 'Custom' })
    expect(presetDisplayText({ id: 'mine-without-description', trust: 'user', name: 'Mine' }, translate))
      .toEqual({ name: 'Mine' })
  })
})
