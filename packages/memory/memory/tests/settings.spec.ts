/** Effective memory switch notifications cover real settings providers and source ownership. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import MemoryService, { MEMORY_SETTINGS_NAMESPACE, type MemorySwitches } from '../src/index.ts'
import { memoryHarness } from './harness.ts'

it.each([false, true])('announces provider attachment, commit and composition fallback (base features %s)', async (base) => {
  const h = await memoryHarness({ config: { recall: base, extraction: base, consolidation: base } })
  const observed: MemorySwitches[] = []
  h.ctx.on('memory/switches-updated', () => observed.push({ ...h.ctx.memory.switches() }))
  const initial = { enabled: true, recall: base, extraction: base, consolidation: base }
  try {
    expect(h.service.switches()).toEqual(initial)
    const provided = { enabled: !base, recall: !base, extraction: !base, consolidation: !base }
    const provider = h.ctx.plugin(MemorySettings, { doc: { memory: provided } })
    await provider
    await vi.waitFor(() => { expect(h.service.switches()).toEqual(provided) })
    expect(observed.at(-1)).toEqual(provided)
    await h.ctx.settings.update(MEMORY_SETTINGS_NAMESPACE, initial)
    expect(observed.at(-1)).toEqual(initial)
    await provider.dispose()
    expect(h.service.switches()).toEqual(initial)
    expect(observed.at(-1)).toEqual(initial)
  } finally { await h.ctx.fiber.dispose() }
})

it('delivers effective switches to later observers when another observer fails', async () => {
  const h = await memoryHarness()
  const failure = new Error('switch observer failed')
  const warn = vi.spyOn(h.ctx.logger, 'warn')
  const observed: MemorySwitches[] = []
  h.ctx.on('memory/switches-updated', () => { throw failure })
  h.ctx.on('memory/switches-updated', () => observed.push({ ...h.ctx.memory.switches() }))
  try {
    await h.ctx.plugin(MemorySettings)
    await vi.waitFor(() => { expect(observed.length).toBeGreaterThan(0) })
    await h.ctx.settings.update(MEMORY_SETTINGS_NAMESPACE, { enabled: false })
    expect(observed.at(-1)?.enabled).toBe(false)
    await setImmediate()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errors: [failure] }))
  } finally { await h.ctx.fiber.dispose() }
})

it('removes the namespace bridge with its service and attaches a replacement once', async () => {
  const h = await memoryHarness()
  const observed: MemorySwitches[] = []
  h.ctx.on('memory/switches-updated', () => observed.push({ ...h.ctx.memory.switches() }))
  try {
    await h.ctx.plugin(MemorySettings)
    await vi.waitFor(() => { expect(observed.length).toBeGreaterThan(0) })
    await h.fiber.dispose()
    const before = observed.length
    h.ctx.emit('settings/updated', MEMORY_SETTINGS_NAMESPACE, {}, {}, 'provider')
    expect(observed).toHaveLength(before)
    await h.ctx.plugin(MemoryService)
    await vi.waitFor(() => { expect(observed.length).toBe(before + 1) })
    await h.ctx.settings.update(MEMORY_SETTINGS_NAMESPACE, { enabled: false })
    expect(observed).toHaveLength(before + 2)
    expect(observed.at(-1)?.enabled).toBe(false)
  } finally { await h.ctx.fiber.dispose() }
})
