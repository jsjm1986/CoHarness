/** The memory source's Remote-driven snapshots: catalog load, scope selection, and invalidation. */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { MemoryEntry, MemoryScope, MemoryScopeCatalog } from '@deepseek-ai/dsh-memory/client'
import { createMemorySource, type MemorySourceDeps } from '../src/client/memory-source.ts'
import { scopeKeyOf } from '../src/client/memory.ts'

function entry(scopeKey: string, key: string): MemoryEntry {
  const scope = scopeKey === 'project' ? { kind: 'project' as const } : { kind: 'personal' as const }
  return {
    scope, key: key as MemoryEntry['key'], kind: 'guidance', summary: `s-${key}`, content: `c-${key}`,
    revision: `rev-${key}` as MemoryEntry['revision'],
    created: { source: 'agent', at: '2026-01-01T00:00:00.000Z' },
    updated: { source: 'member', userId: 7, at: '2026-01-02T00:00:00.000Z' },
  }
}

function catalog(scopes: MemoryScopeCatalog['scopes']): MemoryScopeCatalog {
  return { enabled: true, scopes }
}

function harness(overrides: Partial<MemorySourceDeps> = {}) {
  const listeners = { changed: new Set<() => void>(), reset: new Set<() => void>() }
  const deps: MemorySourceDeps = {
    scopes: vi.fn(async () => ({
      ok: true as const,
      value: catalog([
        { scope: { kind: 'personal' }, writable: true, entries: 1 },
        { scope: { kind: 'project' }, writable: false, entries: 0 },
      ]),
    })),
    list: vi.fn(async (scope: MemoryScope) => ({ ok: true as const, value: scope.kind === 'personal' ? [entry('personal', 'a')] : [] })),
    save: vi.fn(async () => ({ ok: true as const, value: { ok: true as const, operation: 'create' as const, entry: entry('personal', 'n') } })),
    remove: vi.fn(async () => ({ ok: true as const, value: { ok: true as const, operation: 'delete' as const, entry: entry('personal', 'a') } })),
    subscribeChanged: (listener) => { listeners.changed.add(listener); return () => { listeners.changed.delete(listener) } },
    subscribeReset: (listener) => { listeners.reset.add(listener); return () => { listeners.reset.delete(listener) } },
    openSource: vi.fn(),
    ...overrides,
  }
  const source = createMemorySource(deps)
  return { deps, listeners, source, hook: source.hooks.memory }
}

/** Subscribe the source hook until `stop` releases it. */
async function subscribed<T>(source: ReturnType<typeof harness>, run: () => Promise<T> | T): Promise<T> {
  const unsubscribe = source.hook.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(source.hook.getSnapshot().status).not.toBe('loading') })
    return await run()
  } finally {
    unsubscribe()
  }
}

describe('createMemorySource', () => {
  it('loads the catalog and the first scope on subscribe', async () => {
    const test = harness()
    await subscribed(test, async () => {
      const snapshot = test.hook.getSnapshot()
      expect(snapshot.enabled).toBe(true)
      expect(snapshot.scopes).toHaveLength(2)
      expect(snapshot.selected).toBe('personal')
      expect(snapshot.entries?.map(e => e.key)).toEqual(['a'])
      expect(test.deps.list).toHaveBeenCalledWith({ kind: 'personal' })
    })
  })

  it('keeps the selection across a refresh when the scope still exists', async () => {
    const test = harness()
    await subscribed(test, async () => {
      test.source.select('project')
      await vi.waitFor(() => { expect(test.deps.list).toHaveBeenCalledWith({ kind: 'project' }) })
      expect(test.hook.getSnapshot().selected).toBe('project')
      test.source.refresh()
      await vi.waitFor(() => { expect(test.deps.scopes).toHaveBeenCalledTimes(2) })
      expect(test.hook.getSnapshot().selected).toBe('project')
    })
  })

  it('reloads on a memory/changed event', async () => {
    const test = harness()
    await subscribed(test, async () => {
      for (const listener of test.listeners.changed) listener()
      await vi.waitFor(() => { expect(test.deps.scopes).toHaveBeenCalledTimes(2) })
    })
  })

  it('reloads after a connection reset', async () => {
    const test = harness()
    await subscribed(test, async () => {
      for (const listener of test.listeners.reset) listener()
      await vi.waitFor(() => { expect(test.deps.scopes).toHaveBeenCalledTimes(2) })
    })
  })

  it('prefers the workspace scope matching the session directory on first load', async () => {
    const test = harness({
      scopes: vi.fn(async () => ({
        ok: true as const,
        value: catalog([
          { scope: { kind: 'personal' }, writable: true, entries: 0 },
          { scope: { kind: 'workspace', directory: '/repo/a' }, writable: true, entries: 2 },
          { scope: { kind: 'workspace', directory: '/repo/b' }, writable: true, entries: 1 },
        ]),
      })),
      sessionDirectory: () => '/repo/b',
    })
    await subscribed(test, async () => {
      expect(test.hook.getSnapshot().selected).toBe(scopeKeyOf({ kind: 'workspace', directory: '/repo/b' }))
      await vi.waitFor(() => {
        expect(test.deps.list).toHaveBeenCalledWith({ kind: 'workspace', directory: '/repo/b' })
      })
    })
  })

  it('keeps a manual selection through catalog reloads', async () => {
    const test = harness({ sessionDirectory: () => '/repo/b' })
    await subscribed(test, async () => {
      test.source.select('project')
      expect(test.hook.getSnapshot().selected).toBe('project')
      test.listeners.changed.forEach(listener => listener())
      await vi.waitFor(() => { expect(test.deps.scopes).toHaveBeenCalledTimes(2) })
      expect(test.hook.getSnapshot().selected).toBe('project')
    })
  })

  it('reports an error snapshot when the catalog read fails', async () => {
    const test = harness({
      scopes: vi.fn(async () => ({
        ok: false as const,
        error: { isDSHRemoteError: true, name: 'RemoteError', code: 'gateway/internal', message: 'x', details: {} } as RemoteFailure,
      })),
    })
    await subscribed(test, () => {
      expect(test.hook.getSnapshot().status).toBe('error')
    })
  })

  it('re-reads after an accepted write', async () => {
    const test = harness()
    await subscribed(test, async () => {
      const result = await test.source.save({ scope: { kind: 'personal' }, key: 'n', kind: 'guidance', summary: 's', content: 'c' })
      expect(result.ok && result.value.ok).toBe(true)
      await vi.waitFor(() => { expect(test.deps.scopes).toHaveBeenCalledTimes(2) })
    })
  })

  it('unsubscribes remote listeners when the last subscriber leaves', async () => {
    const test = harness()
    const unsubscribe = test.hook.subscribe(() => {})
    await vi.waitFor(() => { expect(test.hook.getSnapshot().status).toBe('ready') })
    unsubscribe()
    expect(test.listeners.changed.size).toBe(0)
    expect(test.listeners.reset.size).toBe(0)
  })
})

describe('scopeKeyOf', () => {
  it('is stable and unique across scope kinds', () => {
    expect(scopeKeyOf({ kind: 'personal' })).toBe('personal')
    expect(scopeKeyOf({ kind: 'project' })).toBe('project')
    expect(scopeKeyOf({ kind: 'workspace', directory: '/a' })).not.toBe(scopeKeyOf({ kind: 'workspace', directory: '/b' }))
  })
})
