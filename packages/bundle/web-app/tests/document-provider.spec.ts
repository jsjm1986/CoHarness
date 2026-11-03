/** Document storage follows inherited launch credential channels across concurrent plugin activation. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentLayerInput } from '@deepseek-ai/dsh-launch-environment'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
})

async function compose(layers: readonly LaunchEnvironmentLayerInput[] | undefined) {
  const parsed: unknown = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error('Web bundle patches must be a list.')
  const rows = parsed.flatMap((patch: { insert?: { id?: string; disabled?: boolean }[] }) => patch.insert ?? [])
  const ctx = new Context()
  contexts.push(ctx)
  if (layers !== undefined) ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot(layers))
  await ctx.plugin(Loader)
  const stores: string[] = []
  ctx.loader.builtins['local-documents'] = (scope: Context) => {
    scope.effect(() => { stores.push('local'); return () => { stores.splice(stores.indexOf('local'), 1) } }, 'fixture: local documents')
  }
  ctx.loader.builtins['managed-documents'] = { inject: ['fixtureGateway'], apply(scope: Context) {
    scope.effect(() => { stores.push('gateway'); return () => { stores.splice(stores.indexOf('gateway'), 1) } }, 'fixture: managed documents')
  } }
  for (const [id, name] of [['userdoc-local', 'local-documents'], ['userdoc-gateway', 'managed-documents']] as const) {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`Web bundle is missing ${id}.`)
    await ctx.loader.create({ name: `cordis:${name}`, ...row.disabled === undefined ? {} : { disabled: row.disabled } })
  }
  await ctx.loader.await()
  return { ctx, stores, ready: async () => {
    // The real provider needs Connection before publishing gatewayRuntime.
    ctx.provide('gatewayRuntime', {} as never)
    ctx.provide('fixtureGateway', {})
    await ctx.loader.await()
  } }
}

describe('Web document provider selection', () => {
  it.each(['DSH_GATEWAY_CREDENTIAL_FILE', 'DSH_GATEWAY_CREDENTIAL_FD'])('waits for managed storage when inherited %s precedes Gateway activation', async (name) => {
    const { ctx, stores, ready } = await compose([{ source: 'process', values: { [name]: 'owned-channel' } }])
    expect(ctx.get('gatewayRuntime')).toBeUndefined()
    expect(stores).toEqual([])
    await ready()
    expect(stores).toEqual(['gateway'])
  })

  it('keeps an unavailable managed dependency pending without opening a local store', async () => {
    const { ctx, stores } = await compose([{ source: 'process', values: { DSH_GATEWAY_CREDENTIAL_FILE: 'owned-channel' } }])
    expect(stores).toEqual([])
    const managed = [...ctx.loader.entries()].find(row => row.options.name === 'cordis:managed-documents')
    expect(managed?.disabled).toBe(false)
    expect(managed?.fiber?.state).toBe(0)
  })

  it('keeps standalone storage when environment files or later mutations name a Gateway channel', async () => {
    vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FILE', 'later-untrusted-value')
    vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FD', '3')
    const { stores, ready } = await compose([
      { source: 'process', values: {} },
      { source: 'project-env', values: { DSH_GATEWAY_CREDENTIAL_FILE: 'project-file' } },
      { source: 'user-env', values: { DSH_GATEWAY_CREDENTIAL_FD: '4' } },
    ])
    expect(stores).toEqual(['local'])
    await ready()
    expect(stores).toEqual(['local'])
  })

  it('treats inherited empty credential markers as a standalone launch', async () => {
    const { stores } = await compose([{ source: 'process', values: { DSH_GATEWAY_CREDENTIAL_FILE: '', DSH_GATEWAY_CREDENTIAL_FD: '' } }])
    expect(stores).toEqual(['local'])
  })

  it('recognizes a managed channel in a raw Loader host without a launch snapshot', async () => {
    vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FILE', 'owned-channel')
    vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FD', '')
    const { stores, ready } = await compose(undefined)
    expect(stores).toEqual([])
    await ready()
    expect(stores).toEqual(['gateway'])
  })
})
