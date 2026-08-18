import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '../src/index.ts'
import type { CredentialRef, ReadOnlyCredentialLayer } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')

async function boot(seed: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  return ctx
}

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('lower_case9')).toBe('lower_case9')
  })

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError)
    }
  })
})

describe('the credentials seam through the memory provider', () => {
  it('mounts as ctx.credentials and resolves a seeded reference with its source', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-seeded', source: 'memory' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'memory', writable: true })
  })

  it('treats an empty stored value as absent everywhere', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: '' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
  })

  it('stores through set, removes through unset, and emits the committed change', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await ctx.credentials.set(REF, 'sk-live')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-live', source: 'memory' })
    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(events).toEqual([REF, REF])
  })

  it('rejects an empty set and keeps an absent unset silent', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await ctx.credentials.unset(REF)
    expect(events).toEqual([])
  })

  it('gives a claimed read-only reference exclusive ownership until its registration is disposed', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-personal' })
    const layer: ReadOnlyCredentialLayer = {
      id: 'organization',
      owns: ref => ref === REF,
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: false }),
    }
    const unregister = ctx.credentials.registerReadOnlyLayer(layer)

    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: false })
    await expect(ctx.credentials.set(REF, 'sk-replacement')).rejects.toThrow(/read-only.*organization/)
    await expect(ctx.credentials.unset(REF)).rejects.toThrow(/read-only.*organization/)

    unregister()
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-personal', source: 'memory' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'memory', writable: true })
  })

  it('fails loud when multiple read-only layers claim one reference', async () => {
    const ctx = await boot()
    const layer = (id: string): ReadOnlyCredentialLayer => ({
      id,
      owns: ref => ref === REF,
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: false }),
    })
    ctx.credentials.registerReadOnlyLayer(layer('first'))
    ctx.credentials.registerReadOnlyLayer(layer('second'))

    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/owned by multiple read-only layers: first, second/)
  })

  it('removes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryCredentials)
    expect(ctx.get('credentials')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('credentials')).toBeUndefined()
  })
})
