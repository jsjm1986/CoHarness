#!/usr/bin/env node
/** Own a real JSON acquisition across Loader unload, then persist through the replacement's model tools. */
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const path = process.argv[2]
if (path === undefined) throw new Error('Memory lifecycle scenario requires a configuration')
const ctx = await boot('memory-lifecycle-snapshot', resolveConfigPath(path, undefined))
try {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.id.endsWith(':memory'))
  if (entry?.fiber === undefined) throw new Error('Memory lifecycle scenario requires the actual Loader entry')
  await entry.fiber.dispose()
  const facet = ctx.storage.backend.get('json').kv
  if (facet === undefined) throw new Error('Memory lifecycle scenario requires JSON records')
  const original = Object.getOwnPropertyDescriptor(facet, 'open'), open = facet.open.bind(facet)
  let entered!: () => void, release!: () => void, closes = 0
  const openingEntered = new Promise<void>((resolve) => { entered = resolve })
  const openingReleased = new Promise<void>((resolve) => { release = resolve })
  Object.defineProperty(facet, 'open', { configurable: true, value: async (...args: Parameters<typeof open>) => {
    const unit = await open(...args), close = unit.close.bind(unit)
    unit.close = async () => { closes += 1; await close() }
    entered()
    await openingReleased
    return unit
  } })
  const opening = entry.init()
  let unloading: Promise<void> | undefined
  let failure: unknown
  try {
    await openingEntered
    const fiber = entry.fiber
    if (fiber === undefined) throw new Error('Loader did not retain the opening memory provider')
    unloading = fiber.dispose()
    if (fiber.uid !== null) throw new Error('Memory disposal did not enter unloading')
  } catch (error) {
    failure = error
  } finally {
    release()
    const outcomes = await Promise.allSettled([unloading, opening])
    if (original === undefined) Reflect.deleteProperty(facet, 'open')
    else Object.defineProperty(facet, 'open', original)
    const failures = outcomes.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failure !== undefined) failures.unshift(failure)
    if (failures.length > 0) throw new AggregateError(failures, 'Memory lifecycle setup or cleanup failed')
  }
  if (closes !== 1 || ctx.storageDomain.get('memory') !== undefined) throw new Error('Opening memory domain survived provider unloading')
  await entry.init()
  await runFixtureTurn(ctx, { task: 'Remember the release freeze.' })
  const keys = (await ctx.memory.entries({ kind: 'personal' })).map(value => value.key)
  process.stdout.write(`${JSON.stringify({ closedDuringUnload: true, replacementReady: true, keys })}\n`)
} finally { await ctx.fiber.dispose() }
