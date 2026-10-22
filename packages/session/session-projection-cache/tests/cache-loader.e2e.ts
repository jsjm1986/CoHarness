/** Loader-composed cache reads preserve opaque projection values across a durable close/reopen. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SessionPlugin from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as ProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import * as StoragePlugin from '@deepseek-ai/dsh-storage'
import * as JsonStoragePlugin from '@deepseek-ai/dsh-storage-json'
import * as DomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import * as CachePlugin from '../src/index.ts'
import { projectionCacheDomainSpec } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'cache-loader/opaque': JsonValue
  }
  interface SessionProjectionMap {
    'cache-loader/opaque': JsonValue
  }
}

it('preserves opaque checkpoint state after the Loader tree closes and reopens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cache-loader-'))
  const contexts: Context[] = []
  const id = SessionId('opaque-reopen')
  const value: JsonValue = {
    ['__proto__']: { retained: 'root' },
    nested: { ['__proto__']: { retained: 'nested' }, constructor: 'ordinary data' },
    items: [{ ['__proto__']: ['retained in an array'] }],
  }
  const json = z.custom<JsonValue>(isJsonValue)
  const unit = {
    key: 'cache-loader/opaque',
    stateSchema: json,
    init: () => value,
    apply: state => state,
    wire: { viewSchema: json, view: state => state },
    stateVersion: 1,
  } satisfies ProjectionDefinition<'cache-loader/opaque', JsonValue>
  let reopened: JsonValue | undefined
  const boot = async (mode: 'write' | 'read'): Promise<Context> => {
    const ctx = new Context()
    contexts.push(ctx)
    const consumer = {
      name: 'opaque-checkpoint-consumer',
      inject: ['sessions', 'sessionPersistence', 'sessionProjections', 'sessionProjectionCache'],
      async apply(consumerCtx: Context) {
        consumerCtx.sessionProjections.register(unit)
        if (mode === 'write') {
          const session = consumerCtx.sessions.create(id)
          const handle = await consumerCtx.sessionPersistence.create(session.header)
          try {
            await consumerCtx.sessionProjectionCache.write(session)
          } finally {
            await handle.close()
          }
        } else {
          const handle = await consumerCtx.sessionPersistence.open(id, 'read')
          try {
            reopened = consumerCtx.sessionProjectionCache.cachedSnapshot(handle.header, handle.inheritedEventCount)
              ?.values['cache-loader/opaque']
          } finally {
            await handle.close()
          }
        }
      },
    }
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      loadCache: new Map(),
      async import(specifier: string) {
        switch (specifier) {
          case '@deepseek-ai/dsh-session': return SessionPlugin
          case '@deepseek-ai/dsh-session-persistence-jsonl': return JsonlPlugin
          case '@deepseek-ai/dsh-session-projection': return ProjectionPlugin
          case '@deepseek-ai/dsh-session-projection-cache': return CachePlugin
          case '@deepseek-ai/dsh-storage': return StoragePlugin
          case '@deepseek-ai/dsh-storage-json': return JsonStoragePlugin
          case '@deepseek-ai/dsh-storage-domain': return DomainPlugin
          case 'opaque-checkpoint-consumer': return consumer
          default: throw new Error(`Unexpected plugin: ${specifier}`)
        }
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
    await ctx.loader.await()
    const fiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'consumer')?.fiber
    if (fiber === undefined) throw new Error('Checkpoint consumer was not mounted')
    await fiber.await()
    expect(fiber.state).toBe(FiberState.ACTIVE)
    return ctx
  }
  try {
    await writeFile(join(root, 'cordis.yml'), JSON.stringify([
      { name: '@deepseek-ai/dsh-storage' },
      { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storages') } },
      { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
      { name: '@deepseek-ai/dsh-session' },
      { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: '@deepseek-ai/dsh-session-projection' },
      { name: '@deepseek-ai/dsh-session-projection-cache', config: { writeEveryEvents: 100, writeIntervalMs: 60_000 } },
      { id: 'consumer', name: 'opaque-checkpoint-consumer' },
    ]))
    const writer = await boot('write')
    await writer.fiber.dispose()
    const path = join(root, 'storages', projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
    const document = JSON.parse(await readFile(path, 'utf8')) as { record: { rows: Record<string, { val: JsonValue }> } }
    expect(document.record.rows['cache-loader/opaque']?.val).toStrictEqual(value)
    const reader = await boot('read')
    expect(reopened).toStrictEqual(value)
    await reader.fiber.dispose()
  } finally {
    try {
      const settled = await Promise.allSettled(contexts.map(ctx => ctx.fiber.dispose()))
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as Error)
      if (failures.length !== 0) throw new AggregateError(failures, 'Checkpoint test cleanup failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
