/** The persisted language seam: default Chinese, the English dictionaries, and localized-metadata resolution. */
import { describe, expect, it, vi } from 'vitest'
import { adminLanguage, setAdminLanguage } from './language.ts'
import { resolveLocalized, translatePlugin } from './plugins/presentation.ts'

describe('adminLanguage', () => {
  it('defaults to Chinese and persists an English choice', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    expect(adminLanguage()).toBe('zh')
    setAdminLanguage('en')
    expect(adminLanguage()).toBe('en')
    setAdminLanguage('zh')
    expect(adminLanguage()).toBe('zh')
    vi.unstubAllGlobals()
  })

  it('keeps Chinese when storage denies access', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    expect(adminLanguage()).toBe('zh')
    expect(() => setAdminLanguage('en')).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('translatePlugin', () => {
  it('reads the language\'s dictionary and interpolates parameters', () => {
    expect(translatePlugin('zh')('targetUser', { name: 'Ada' })).toBe('用户 · Ada')
    expect(translatePlugin('en')('targetUser', { name: 'Ada' })).toBe('User · Ada')
  })
})

describe('resolveLocalized', () => {
  it('prefers the surface language and falls back across the pair', () => {
    expect(resolveLocalized({ zh: '中文', en: 'English' }, 'en')).toBe('English')
    expect(resolveLocalized({ zh: '中文', en: 'English' }, 'zh')).toBe('中文')
    expect(resolveLocalized({ en: 'English' }, 'zh')).toBe('English')
    expect(resolveLocalized('literal', 'en')).toBe('literal')
    expect(resolveLocalized('', 'zh')).toBeUndefined()
  })
})
