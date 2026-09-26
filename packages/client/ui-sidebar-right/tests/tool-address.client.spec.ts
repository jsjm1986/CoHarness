/** Tool tab addresses carry an explicit Session and call identity. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseToolAddress, toolAddress } from '../src/client/tabs/tool/address.ts'

describe('tool addresses', () => {
  it('round-trips a Session and call through URI-encoded path segments', () => {
    const address = toolAddress('s one' as SessionId, 'call/42')
    expect(address).toBe('dsh-resource://tool/session/s%20one/call%2F42')
    expect(parseToolAddress(address)).toEqual({ sessionId: 's one', callId: 'call/42' })
  })

  it('rejects foreign schemes, missing segments, and malformed encoding', () => {
    expect(parseToolAddress('dsh-resource://file/session/s/c')).toBeUndefined()
    expect(parseToolAddress('dsh-resource://tool/session/only')).toBeUndefined()
    expect(parseToolAddress('dsh-resource://tool/session/%/c')).toBeUndefined()
  })
})
