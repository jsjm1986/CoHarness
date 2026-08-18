import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  errorCodeForDiagnostics,
  isTransientDatabaseError,
  withDatabaseStartupRetry,
} from '../src/postgres/database.ts'

describe('database startup retry', () => {
  it('retries transient connection failures with bounded exponential delay', async () => {
    let attempts = 0
    const delays: number[] = []
    const result = await withDatabaseStartupRetry(async () => {
      attempts += 1
      if (attempts < 3) throw { code: 'ECONNREFUSED' }
      return 'ready'
    }, {
      initialDelayMs: 1,
      maxDelayMs: 2,
      onRetry: (_error, delayMs) => delays.push(delayMs),
    })

    expect(result).toBe('ready')
    expect(attempts).toBe(3)
    expect(delays).toEqual([1, 2])
  })

  it('fails immediately for non-transient migration or credential errors', async () => {
    const failure = Object.assign(new Error('invalid password'), { code: '28P01' })
    await expect(withDatabaseStartupRetry(async () => { throw failure }, {
      initialDelayMs: 1,
      maxDelayMs: 2,
    })).rejects.toBe(failure)
    expect(isTransientDatabaseError(failure)).toBe(false)
  })

  it('recognizes wrapped network errors without exposing their message in diagnostics', () => {
    const wrapped = new Error('connection failed', { cause: { code: '08006' } })
    expect(isTransientDatabaseError(wrapped)).toBe(true)
    expect(errorCodeForDiagnostics(wrapped)).toBe('unknown')
    expect(errorCodeForDiagnostics({ code: 'ECONNRESET' })).toBe('ECONNRESET')
    expect(errorCodeForDiagnostics('not-an-error')).toBe('unknown')
  })

  it('aborts a pending retry when the process is being replaced', async () => {
    const controller = new AbortController()
    let attempts = 0
    const pending = withDatabaseStartupRetry(async () => {
      attempts += 1
      throw { code: 'ECONNREFUSED' }
    }, {
      initialDelayMs: 100,
      maxDelayMs: 100,
      signal: controller.signal,
    })
    await setImmediate()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(attempts).toBe(1)
  })
})
