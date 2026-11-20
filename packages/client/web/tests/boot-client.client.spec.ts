// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import {
  createClientModuleSystem, parseBootManifest,
  type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget, type WebBootEntry, type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertEntriesActive, bootClient, type EntryStateLabel } from '../src/boot-client.ts'
import { FIBER_STATE } from '../src/loader-status.ts'
import { mountClient } from '../src/mount.ts'

const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'

function graphOf(ids: readonly string[]): WebBootGraph {
  const entries: WebBootEntry[] = ids.map(id => ({ id, url: `/${id}.js`, rev: '1' }))
  return {
    rev: 'graph',
    entries,
    batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: [...ids] }],
  }
}

/** Module system seeded with inline plugin modules; `loaded` records every transport call. */
function modulesOf(
  graph: WebBootGraph, staticModules: Record<string, unknown>, load?: (url: string) => Promise<void>,
): { modules: ClientModuleLoader; loaded: string[] } {
  const loaded: string[] = []
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, { id: BOOTSTRAP_ID, exports: {} }, options),
  }
  const modules = target.create({
    boot: graph,
    staticModules,
    loadBundle: async (url) => {
      loaded.push(url)
      await load?.(url)
    },
  })
  return { modules, loaded }
}

/** Recording progress sink. */
function stateSink(): { states: Map<string, EntryStateLabel[]>; onEntryState: (name: string, state: EntryStateLabel) => void } {
  const states = new Map<string, EntryStateLabel[]>()
  return {
    states,
    onEntryState: (name, state) => { states.set(name, [...(states.get(name) ?? []), state]) },
  }
}

describe('bootClient', () => {
  it('audits required entries and mounts the renderer before requesting optional bytes', async () => {
    const graph = graphOf(['renderer', 'extra'])
    graph.entries[1]!.optional = true
    const started = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    const container = document.createElement('main')
    const { modules, loaded } = modulesOf(graph, {
      renderer: { apply: (ctx: Context) => {
        ctx.reflect.provide('uiRenderer', {
          mount: (el: HTMLElement) => {
            el.append(document.createElement('input'))
            return () => { el.replaceChildren() }
          },
        })
      } },
    }, async () => {
      started.resolve(undefined)
      await settled.promise
      throw new Error('optional transport unavailable')
    })
    const ctx = new Context()
    ctx.provide('modules', modules)
    onTestFinished(async () => {
      settled.resolve(undefined)
      await ctx.fiber.dispose()
    })
    const sink = stateSink()

    await bootClient({ ctx, modules, manifest: modules.manifest, onEntryState: sink.onEntryState })
    await mountClient(ctx, container)
    expect(loaded).toEqual([])
    expect(sink.states.get('extra')).toBeUndefined()
    expect(sink.states.get('renderer')?.at(-1)).toBe('active')
    await started.promise
    const input = container.querySelector('input')
    expect(input).toBeInstanceOf(HTMLInputElement)
    expect(input?.disabled).toBe(false)
    settled.resolve(undefined)
    await modules.entries.startOptional()
    const failures = modules.entries.state.getSnapshot().failures
    expect(failures.map(failure => failure.id)).toEqual(['extra'])
    expect(failures[0]?.message).toContain('optional transport unavailable')
    expect(container.querySelector('input')).toBe(input)
  })

  it('blocks when a required entry depends on an unavailable optional package', async () => {
    const graph = graphOf(['renderer', 'adapter'])
    graph.entries[0]!.inject = ['adapter']
    graph.entries[1]!.optional = true
    const { modules } = modulesOf(graph, {
      renderer: { inject: ['adapter'], apply: () => {} },
    }, async () => { throw new Error('adapter transport unavailable') })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })

    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow(/adapter: import failed/)
  })

  it('activates every seeded row without touching the bundle transport', async () => {
    const graph = graphOf(['provider', 'consumer'])
    const { modules, loaded } = modulesOf(graph, {
      provider: { apply: (ctx: Context) => { ctx.reflect.provide('x', { marker: 'x' }) } },
      consumer: { inject: ['x'], apply: () => {} },
    })
    const ctx = new Context()
    const sink = stateSink()

    await bootClient({ ctx, modules, manifest: modules.manifest, onEntryState: sink.onEntryState })

    expect(loaded).toEqual([])
    const consumer = sink.states.get('consumer') ?? []
    expect(consumer[0]).toBe('loading')
    expect(consumer.at(-1)).toBe('active')
    expect(sink.states.get('provider')?.at(-1)).toBe('active')
    await ctx.fiber.dispose()
  })

  it('reports a row waiting on a service the roster never provides', async () => {
    const graph = graphOf(['orphan'])
    const { modules } = modulesOf(graph, { orphan: { inject: ['nothing'], apply: () => {} } })
    const ctx = new Context()

    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow(
      'orphan: pending (waiting for service: nothing)',
    )
    await ctx.fiber.dispose()
  })

  it('reports and logs an import failure for a row that is neither seeded nor a graph row', async () => {
    const { modules } = modulesOf(graphOf(['seeded']), { seeded: { apply: () => {} } })
    const manifest = parseBootManifest(graphOf(['ghost']))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    const sink = stateSink()

    await expect(bootClient({ ctx, modules, manifest, onEntryState: sink.onEntryState })).rejects.toThrow(
      'web boot: 1 entry did not activate\nghost: import failed (see console for the import error)',
    )
    expect(sink.states.get('ghost')).toEqual(['loading', 'failed'])
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toHaveProperty('message', expect.stringContaining('client-modules: cannot resolve'))
  })
})

describe('assertEntriesActive', () => {
  interface FakeEntry { name: string; fiber?: { state: number; inject: Record<string, null> } }

  /** Loader-shaped double: entries with scripted fiber states, services by name. */
  function auditCtx(entries: readonly FakeEntry[], services: Record<string, unknown> = {}): Context {
    return {
      loader: {
        * entries() {
          for (const entry of entries) yield { options: { name: entry.name }, fiber: entry.fiber }
        },
      },
      get: (name: string) => services[name],
    } as unknown as Context
  }

  it('passes when every entry is active', () => {
    expect(() => { assertEntriesActive(auditCtx([{ name: 'a', fiber: { state: FIBER_STATE.ACTIVE, inject: {} } }])) }).not.toThrow()
  })

  it('names import failures, missing services, and other non-active states', () => {
    const ctx = auditCtx([
      { name: 'lost' },
      { name: 'waiting', fiber: { state: FIBER_STATE.PENDING, inject: { present: null, a: null, b: null } } },
      { name: 'opaque', fiber: { state: FIBER_STATE.PENDING, inject: {} } },
      { name: 'broken', fiber: { state: FIBER_STATE.FAILED, inject: {} } },
    ], { present: {} })

    expect(() => { assertEntriesActive(ctx) }).toThrow([
      'web boot: 4 entries did not activate',
      'lost: import failed (see console for the import error)',
      'waiting: pending (waiting for services: a, b)',
      'opaque: pending (waiting for services: unknown)',
      'broken: failed',
    ].join('\n'))
  })

  it('uses the singular form for one failing entry', () => {
    expect(() => { assertEntriesActive(auditCtx([{ name: 'lost' }])) }).toThrow('web boot: 1 entry did not activate\n')
  })
})
