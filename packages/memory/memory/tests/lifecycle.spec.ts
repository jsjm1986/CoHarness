/** Memory domain ownership when asynchronous opening overlaps provider disposal. */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import MemoryService from '../src/index.ts'
import { memoryHarness } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

it('closes a domain acquired while its provider is unloading and permits replacement', async () => {
  const entered = gate(), release = gate()
  let fiber: ReturnType<Context['plugin']> | undefined, closes = 0, first = true
  const starting = memoryHarness({
    beforeService: (ctx) => { contexts.push(ctx) },
    onService: (value) => { fiber = value },
    beforeOpen: (backend) => {
      const open = backend.kv.open.bind(backend.kv)
      backend.kv.open = async (descriptor) => {
        const unit = await open(descriptor)
        const close = unit.close.bind(unit)
        unit.close = async () => { closes += 1; await close() }
        if (first) { first = false; entered.resolve(); await release.promise }
        return unit
      }
    },
  })
  const started = starting.then(value => ({ value }), (error: unknown) => ({ error }))
  let disposal: Promise<void> | undefined
  try {
    await entered.promise
    if (fiber === undefined) throw new Error('Memory provider did not publish its fixture handle')
    disposal = fiber.dispose()
    expect(fiber.uid).toBeNull()
  } finally {
    release.resolve()
    await disposal
  }
  const result = await started
  if ('error' in result) throw result.error
  expect(closes).toBe(1)
  expect(result.value.facility.get('memory')).toBeUndefined()
  await result.value.ctx.plugin(MemoryService)
  expect(await result.value.ctx.memory.entries({ kind: 'personal' })).toEqual([])
})
