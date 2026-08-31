import { describe, expect, it } from 'vitest'
import { displayFailureMessage, isSessionPersistenceFailureMessage } from '../src/client/sessions/failure-display.ts'

describe('displayFailureMessage', () => {
  it('keeps provider authentication guidance without credential details', () => {
    expect(displayFailureMessage({ code: 'AUTH', message: 'bad key sk-secret' }))
      .toBe('API key is invalid')
  })

  it('replaces Gateway persistence internals with safe retry guidance', () => {
    const message = 'Gateway session persistence returned invalid JSON: internal error'
    expect(isSessionPersistenceFailureMessage(message)).toBe(true)
    expect(displayFailureMessage({ code: 'UNKNOWN', message })).toBe('Session could not be saved. Please try again.')
  })

  it('keeps unrelated failure copy intact', () => {
    expect(displayFailureMessage({ code: 'TOOL', message: 'tool failed' })).toBe('tool failed')
    expect(isSessionPersistenceFailureMessage('tool failed')).toBe(false)
  })
})
