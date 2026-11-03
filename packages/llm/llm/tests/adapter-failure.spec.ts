import { describe, expect, it } from 'vitest'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import { normalizeLlmFailure } from '../src/adapter-failure.ts'

describe('adapter failure normalization', () => {
  it.each([
    ['unavailable', 'RESOURCE_BUDGET_UNAVAILABLE'], ['cancelled', 'ABORTED'],
    ['expired', 'RESOURCE_ADMISSION_EXPIRED'], ['refused', 'RESOURCE_ADMISSION_REFUSED'],
  ] as const)('preserves the owned resource admission category %s', (reason, code) => {
    expect(normalizeLlmFailure(new ResourceAdmissionError(reason, 'Local resource admission failed.')))
      .toEqual({ message: 'Local resource admission failed.', code })
  })

  it('keeps SDK reason fields outside the owned resource taxonomy', () => {
    const error = Object.assign(new Error('SDK unavailable'), { name: 'ResourceAdmissionError', reason: 'unavailable' })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'SDK unavailable', code: 'UNKNOWN' })
  })

  it.each([0, 1.5])('rejects an invalid offloaded image count: %s', (offloadImages) => {
    const error = Object.assign(new Error('Provider failed.'), {
      code: 'IMAGE_LIMIT', failure: { message: 'Provider failed.', code: 'IMAGE_LIMIT', offloadImages },
    })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'Provider failed.', code: 'UNKNOWN' })
  })

  it('preserves a valid offloaded image count in detached failure facts', () => {
    const failure = { message: 'Image limit.', code: 'IMAGE_LIMIT', offloadImages: 2 }
    const error = Object.assign(new Error(failure.message), { code: failure.code, failure })
    expect(normalizeLlmFailure(error)).toEqual(failure)
    expect(normalizeLlmFailure(error)).not.toBe(failure)
  })

  it('preserves validated detailed facts carried by an owned admission error', () => {
    const failure = { message: 'Execution denied.', code: 'EXECUTION_DENIED', status: 403 }
    const error = Object.assign(new ResourceAdmissionError('refused', failure.message), { code: failure.code, failure })
    expect(normalizeLlmFailure(error)).toEqual(failure)
  })

  it.each(['hidden', 'accessor', 'unrecognized', 'throwing'] as const)(
    'contains an unreadable admission reason descriptor: %s', (mode) => {
      const error = new Proxy(new ResourceAdmissionError('refused', 'Admission failed.'), {
        getOwnPropertyDescriptor(target, property) {
          if (property !== 'reason') return Reflect.getOwnPropertyDescriptor(target, property)
          if (mode === 'throwing') throw new Error('Descriptor unavailable.')
          if (mode === 'hidden') return undefined
          if (mode === 'accessor') return { configurable: true, get: () => { throw new Error('Do not invoke SDK accessors.') } }
          return { configurable: true, value: '__proto__' }
        },
      })
      expect(normalizeLlmFailure(error)).toEqual({ message: 'Admission failed.', code: 'UNKNOWN' })
    },
  )
  it('contains hostile non-Error coercion', () => {
    const thrown = { [Symbol.toPrimitive]: () => { throw new Error('coercion failed') } }
    expect(normalizeLlmFailure(thrown)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('normalizes empty primitive throws and data descriptors without values', () => {
    expect(normalizeLlmFailure('')).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
    expect(normalizeLlmFailure(null)).toEqual({ message: 'null', code: 'UNKNOWN' })

    const error = new Error('provider failed')
    Object.defineProperty(error, 'failure', { get: () => ({ message: 'ignored', code: 'IGNORED' }) })
    Object.defineProperty(error, 'code', { get: () => 'IGNORED' })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorCode = Object.assign(new Error('provider failed'), {
      failure: { message: 'provider failed', code: 'FOREIGN' },
    })
    Object.defineProperty(accessorCode, 'code', { get: () => 'FOREIGN' })
    expect(normalizeLlmFailure(accessorCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const primitiveFailure = Object.assign(new Error('provider failed'), {
      failure: null,
      code: 'FOREIGN',
    })
    expect(normalizeLlmFailure(primitiveFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('contains hostile Error property reflection', () => {
    const withFailure = new Error('provider failed') as Error & { failure: unknown; code: string }
    withFailure.failure = { message: 'provider failed', code: 'FOREIGN' }
    withFailure.code = 'FOREIGN'
    const hostileCode = new Proxy(withFailure, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'code') throw new Error('code descriptor failed')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(normalizeLlmFailure(hostileCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const hostileFailure = new Proxy(new Error('provider failed'), {
      getOwnPropertyDescriptor() { throw new Error('failure descriptor failed') },
    })
    expect(normalizeLlmFailure(hostileFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('rejects malformed or accessor-backed failure snapshots', () => {
    const malformed = new Error('provider failed') as Error & { failure: unknown; code: string }
    malformed.failure = { message: 'provider failed', code: 'FOREIGN', requestId: '' }
    malformed.code = 'FOREIGN'
    expect(normalizeLlmFailure(malformed)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorBacked = new Error('provider failed') as Error & { failure: unknown }
    accessorBacked.failure = Object.defineProperty({}, 'message', {
      get() { throw new Error('failure getter failed') },
    })
    expect(normalizeLlmFailure(accessorBacked)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('falls back when an Error message accessor throws', () => {
    const error = new Error('provider failed')
    Object.defineProperty(error, 'message', { get() { throw new Error('message getter failed') } })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })
})
