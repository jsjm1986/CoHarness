/** Revoked method layers preserve other owners and never call their released implementation. */
import { expect, it, vi } from 'vitest'
import { createReplaceHelper } from '../src/package-methods.ts'

it('preserves the receiver, arguments and return value, and restores the original method', () => {
  const target = { method(this: { base: number }, amount: number) { return this.base + amount } }
  const original = target.method
  const owner = createReplaceHelper(target)
  const dispose = owner.replaceMethod('method', function (amount) { return owner.rawImpl.method.call(this, amount) * 2 })
  expect(target.method.call({ base: 7 }, 3)).toBe(20)
  dispose(); dispose()
  expect(target.method).toBe(original)
})

it.each([false, true])('keeps another layer usable and restores the original after either disposal order (outer first: %s)', (outerFirst) => {
  const target = { method: () => 'original' }
  const original = target.method
  const inner = createReplaceHelper(target), innerCall = vi.fn(() => inner.rawImpl.method() + ':inner')
  const retireInner = inner.replaceMethod('method', innerCall)
  const outer = createReplaceHelper(target)
  const retireOuter = outer.replaceMethod('method', () => outer.rawImpl.method() + ':outer')
  expect(target.method()).toBe('original:inner:outer')
  if (outerFirst) {
    retireOuter()
    expect(target.method()).toBe('original:inner')
    retireInner()
  } else {
    retireInner()
    innerCall.mockClear()
    expect(target.method()).toBe('original:outer')
    expect(innerCall).not.toHaveBeenCalled()
    retireOuter()
  }
  expect(target.method).toBe(original)
})

it('preserves a foreign replacement and makes its retained retired callback delegate without owner state', () => {
  const target = { method: () => 'original' }
  const owner = createReplaceHelper(target), owned = vi.fn(() => 'owned')
  const retire = owner.replaceMethod('method', owned)
  const retained = target.method
  const foreign = () => 'foreign'
  target.method = foreign
  retire()
  expect(target.method).toBe(foreign)
  expect(retained()).toBe('original')
  expect(owned).not.toHaveBeenCalled()
})
