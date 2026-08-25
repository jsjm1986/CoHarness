// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installAbortSignalCompatibility } from '../src/abort-signal.ts'

const native = {
  any: Object.getOwnPropertyDescriptor(AbortSignal, 'any')?.value as typeof AbortSignal.any,
  timeout: Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')?.value as typeof AbortSignal.timeout,
  abort: Object.getOwnPropertyDescriptor(AbortSignal, 'abort')?.value as typeof AbortSignal.abort,
}

afterEach(() => {
  AbortSignal.any = native.any
  AbortSignal.timeout = native.timeout
  AbortSignal.abort = native.abort
})

describe('AbortSignal browser compatibility', () => {
  it('fills missing static factories without replacing native ones', () => {
    Reflect.deleteProperty(AbortSignal, 'any')
    Reflect.deleteProperty(AbortSignal, 'timeout')
    Reflect.deleteProperty(AbortSignal, 'abort')

    installAbortSignalCompatibility(AbortSignal)

    expect(typeof AbortSignal.any).toBe('function')
    expect(typeof AbortSignal.timeout).toBe('function')
    expect(typeof AbortSignal.abort).toBe('function')

    const controller = new AbortController()
    const combined = AbortSignal.any([controller.signal])
    controller.abort('user-cancelled')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('user-cancelled')
  })

  it('keeps an already-aborted source reason and supports an empty source list', () => {
    Reflect.deleteProperty(AbortSignal, 'any')
    installAbortSignalCompatibility(AbortSignal)

    const source = AbortSignal.abort('already-cancelled')
    const combined = AbortSignal.any([source])
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('already-cancelled')
    expect(AbortSignal.any([]).aborted).toBe(false)
  })
})
