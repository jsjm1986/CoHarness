// @vitest-environment jsdom
/** Favorites never restore resource names or replace another tab's environment selection. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSpaceNavigationPreferences, recordSpaceVisit, savedSpaceRuntimeIds, toggleSpaceFavorite } from '../src/client/space-navigation-preferences.ts'

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('space navigation preferences', () => {
  it('keeps per-Runtime favorites across independent writes and filters them by account and directory', () => {
    expect(toggleSpaceFavorite(7, 'runtime-a')).toBe(true)
    expect(toggleSpaceFavorite(7, 'runtime-b')).toBe(true)
    expect(readSpaceNavigationPreferences(7, ['runtime-a', 'runtime-b', 'runtime-a']).favorites).toEqual(['runtime-a', 'runtime-b'])
    expect(readSpaceNavigationPreferences(8, ['runtime-a', 'runtime-b']).favorites).toEqual([])
    expect(readSpaceNavigationPreferences(7, ['runtime-b']).favorites).toEqual(['runtime-b'])
    expect(toggleSpaceFavorite(7, 'runtime-a')).toBe(true)
    expect(readSpaceNavigationPreferences(7, ['runtime-a', 'runtime-b']).favorites).toEqual(['runtime-b'])
  })

  it('discovers saved IDs outside loaded pages without restoring another account or malformed storage keys', () => {
    const id = '10000000-0000-4000-8000-000000000009'
    toggleSpaceFavorite(7, id)
    recordSpaceVisit(7, id)
    toggleSpaceFavorite(8, '10000000-0000-4000-8000-000000000008')
    toggleSpaceFavorite(7, 'invalid-id')
    expect(savedSpaceRuntimeIds(7)).toEqual([id])
  })

  it('orders only authorized recent destinations and leaves favorites intact', () => {
    const now = vi.spyOn(Date, 'now')
    toggleSpaceFavorite(7, 'runtime-a')
    for (let index = 0; index < 10; index++) {
      now.mockReturnValue(1_000 + index)
      recordSpaceVisit(7, `runtime-${index}`)
    }
    const preferences = readSpaceNavigationPreferences(7, ['runtime-a', ...Array.from({ length: 10 }, (_, index) => `runtime-${index}`)])
    expect(preferences.favorites).toEqual(['runtime-a'])
    expect(preferences.recent).toEqual(Array.from({ length: 8 }, (_, index) => `runtime-${9 - index}`))
  })

  it('does not claim to save a favorite when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(toggleSpaceFavorite(7, 'runtime-a')).toBe(false)
    expect(() => { recordSpaceVisit(7, 'runtime-a') }).not.toThrow()
    expect(readSpaceNavigationPreferences(7, ['runtime-a'])).toEqual({ favorites: [], recent: [] })
  })
})
