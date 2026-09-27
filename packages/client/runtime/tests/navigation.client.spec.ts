/** Navigation cancellation suppresses stale UI updates without undoing Host work. */
import { describe, expect, it } from 'vitest'
import { NavigationController } from '../src/client/navigation.ts'

describe('NavigationController', () => {
  it('keeps only the latest intent active', () => {
    const navigation = new NavigationController()
    const first = navigation.begin()
    expect(first.aborted).toBe(false)
    const second = navigation.begin()
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    navigation.dispose()
    expect(second.aborted).toBe(true)
    expect(() => navigation.begin()).toThrow('disposed')
  })

  it('permits disposal before an intent and repeated disposal', () => {
    const navigation = new NavigationController()
    navigation.dispose()
    navigation.dispose()
    expect(() => navigation.begin()).toThrow('disposed')
  })
})
