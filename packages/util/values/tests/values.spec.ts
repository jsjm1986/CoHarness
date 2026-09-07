import { describe, expect, it } from 'vitest'
import { assertNever, deepEqualJson, deepFreeze } from '../src/index.ts'

describe('shared value primitives', () => {
  it('reports an unexpected variant with or without JSON text and context', () => {
    expect(() => assertNever('unexpected' as never, 'parser')).toThrow('in parser: "unexpected"')
    expect(() => assertNever(undefined as never)).toThrow('unreachable variant: undefined')
  })

  it('compares own JSON properties independently of inherited values', () => {
    const inherited = Object.create({ required: 1 }) as Record<string, unknown>
    inherited.other = 1
    expect(deepEqualJson({ required: 1 }, inherited)).toBe(false)
    expect(deepEqualJson({ value: [1, null] }, { value: [1, null] })).toBe(true)
    expect(deepEqualJson([1], { 0: 1 })).toBe(false)
    expect(deepEqualJson({ 0: 1 }, [1])).toBe(false)
    expect(deepEqualJson([1], [1, 2])).toBe(false)
    expect(deepEqualJson({ value: 1 }, { value: 2 })).toBe(false)
  })

  it('freezes cyclic shared objects without freezing their cancellation signal', () => {
    const controller = new AbortController()
    const shared = { value: 1 }
    const graph = { left: shared, right: shared, signal: controller.signal, self: {} }
    graph.self = graph
    expect(deepFreeze(graph)).toBe(graph)
    expect(Object.isFrozen(graph)).toBe(true)
    expect(Object.isFrozen(shared)).toBe(true)
    expect(Object.isFrozen(controller.signal)).toBe(false)
    controller.abort('cancelled')
    expect(graph.signal.reason).toBe('cancelled')
  })
})
