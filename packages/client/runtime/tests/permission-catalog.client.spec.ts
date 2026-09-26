import { describe, expect, it, vi } from 'vitest'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'
import type { HostDescription, HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { PermissionCatalogMirror } from '../src/client/permission-catalog.ts'

type CatalogCall = () => Promise<RemoteResult<PermissionCatalog>>

const CATALOG_A: PermissionCatalog = { options: [{ value: 'a', name: 'A' }] }
const CATALOG_B: PermissionCatalog = { options: [{ value: 'b', name: 'B' }] }

const DESCRIPTION_A = { version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true } as HostDescription

/** A description source whose identity flips stand in for generation boundaries. */
function hostDescription(initial?: HostDescription): {
  source: HostDescriptionSource
  publish: (next: HostDescription | undefined) => void
} {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    publish: (next) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const idleHost = () => hostDescription().source

/** Settle the whole microtask queue the mirror settles on. */
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('PermissionCatalogMirror', () => {
  it('installs the first successful pull and notifies subscribers', async () => {
    const mirror = new PermissionCatalogMirror(() => Promise.resolve({ ok: true, value: CATALOG_A }), idleHost())
    const seen: Array<PermissionCatalog | undefined> = []
    mirror.subscribe(() => { seen.push(mirror.getSnapshot()) })
    await flush()
    expect(mirror.getSnapshot()).toBe(CATALOG_A)
    expect(seen).toEqual([CATALOG_A])
  })

  it('drops a response that predates a newer invalidation', async () => {
    let resolveFirst!: (result: RemoteResult<PermissionCatalog>) => void
    const catalog = vi.fn<CatalogCall>()
      .mockImplementationOnce(() => new Promise<RemoteResult<PermissionCatalog>>((resolve) => { resolveFirst = resolve }))
      .mockImplementation(() => Promise.resolve({ ok: true as const, value: CATALOG_B }))
    const mirror = new PermissionCatalogMirror(catalog, idleHost())
    mirror.subscribe(() => {})
    mirror.invalidate()
    resolveFirst({ ok: true, value: CATALOG_A })
    await flush()
    expect(mirror.getSnapshot()).toBe(CATALOG_B)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('clears the served value on a generation boundary before repulling', async () => {
    const host = hostDescription(DESCRIPTION_A)
    const catalog = vi.fn<CatalogCall>()
      .mockImplementationOnce(() => Promise.resolve({ ok: true as const, value: CATALOG_A }))
      .mockImplementation(() => Promise.resolve({ ok: true as const, value: CATALOG_B }))
    const mirror = new PermissionCatalogMirror(catalog, host.source)
    const seen: Array<PermissionCatalog | undefined> = []
    mirror.subscribe(() => { seen.push(mirror.getSnapshot()) })
    await flush()
    host.publish({ ...DESCRIPTION_A })
    expect(mirror.getSnapshot()).toBeUndefined()
    expect(seen).toEqual([CATALOG_A, undefined])
    await flush()
    expect(mirror.getSnapshot()).toBe(CATALOG_B)
  })

  it('clears on generation loss and stays empty while the host is disconnected', async () => {
    const host = hostDescription(DESCRIPTION_A)
    const catalog = vi.fn<CatalogCall>()
      .mockImplementation(() => Promise.resolve({ ok: true as const, value: CATALOG_A }))
    const mirror = new PermissionCatalogMirror(catalog, host.source)
    mirror.subscribe(() => {})
    await flush()
    expect(mirror.getSnapshot()).toBe(CATALOG_A)
    host.publish(undefined)
    await flush()
    expect(mirror.getSnapshot()).toBeUndefined()
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('resolves read() with the catalog and rejects on remote failure', async () => {
    const mirror = new PermissionCatalogMirror(() => Promise.resolve({ ok: true, value: CATALOG_A }), idleHost())
    await expect(mirror.read()).resolves.toBe(CATALOG_A)

    const failing = new PermissionCatalogMirror(() => Promise.resolve({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'forbidden', {}),
    }), idleHost())
    await expect(failing.read()).rejects.toThrow(/permission catalog read failed: gateway\/internal/)
  })

  it('never resolves a read() with a superseded response', async () => {
    let resolveStale!: (result: RemoteResult<PermissionCatalog>) => void
    const catalog = vi.fn<CatalogCall>()
      .mockImplementationOnce(() => new Promise<RemoteResult<PermissionCatalog>>((resolve) => { resolveStale = resolve }))
      .mockImplementation(() => Promise.resolve({ ok: true as const, value: CATALOG_B }))
    const mirror = new PermissionCatalogMirror(catalog, idleHost())
    const staleRead = mirror.read()
    mirror.invalidate()
    resolveStale({ ok: true, value: CATALOG_A })
    // The read shares the replacement pull: it settles on the current catalog,
    // not on the response that predated the invalidation.
    await expect(staleRead).resolves.toBe(CATALOG_B)
    await flush()
    expect(mirror.getSnapshot()).toBe(CATALOG_B)
  })

  it('ticks the invalidation channel before the replacement value lands', async () => {
    const catalog = vi.fn<CatalogCall>()
      .mockImplementation(() => Promise.resolve({ ok: true as const, value: CATALOG_A }))
    const mirror = new PermissionCatalogMirror(catalog, idleHost())
    const ticks: Array<PermissionCatalog | undefined> = []
    mirror.subscribeInvalidations(() => { ticks.push(mirror.getSnapshot()) })
    mirror.subscribe(() => {})
    await flush()
    mirror.invalidate()
    expect(ticks).toEqual([CATALOG_A])
    await flush()
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('never installs after dispose', async () => {
    let resolveLate!: (result: RemoteResult<PermissionCatalog>) => void
    const mirror = new PermissionCatalogMirror(
      () => new Promise<RemoteResult<PermissionCatalog>>((resolve) => { resolveLate = resolve }),
      idleHost(),
    )
    const seen: Array<PermissionCatalog | undefined> = []
    mirror.subscribe(() => { seen.push(mirror.getSnapshot()) })
    mirror.dispose()
    resolveLate({ ok: true, value: CATALOG_A })
    await flush()
    expect(mirror.getSnapshot()).toBeUndefined()
    expect(seen).toEqual([])
  })
})
