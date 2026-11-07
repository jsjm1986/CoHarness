/** Navigation cancellation suppresses stale UI updates without undoing Host work. */
import { describe, expect, it } from 'vitest'
import { NavigationController } from '../src/client/navigation.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

describe('NavigationController', () => {
  it('releases only the current preparation hold without blocking another Session', () => {
    const navigation = new NavigationController()
    const first = navigation.begin('first' as SessionId)
    expect(navigation.blockedSessionId).toBe('first')
    const second = navigation.begin('second' as SessionId)
    expect(navigation.finish(first)).toBe(false)
    expect(navigation.blockedSessionId).toBe('second')
    expect(navigation.finish(second)).toBe(true)
    expect(navigation.blockedSessionId).toBeUndefined()
    expect(second.aborted).toBe(false)
    expect(navigation.finish(second)).toBe(false)
    navigation.begin('first' as SessionId)
    navigation.begin()
    expect(navigation.blockedSessionId).toBeUndefined()
    navigation.begin('first' as SessionId)
    navigation.dispose()
    expect(navigation.blockedSessionId).toBeUndefined()
  })
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
