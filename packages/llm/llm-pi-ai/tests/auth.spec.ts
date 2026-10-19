import { describe, expect, it } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { credentialStoreFrom, recordKeyFor } from '../src/auth.ts'

describe('pi-ai credential record projection', () => {
  it('stores a JSON image of grant values with explicit undefined members removed', async () => {
    const ctx = new Context()
    let stored: CredentialRecord | undefined
    ctx.provide('credentials', {
      modifyRecord: async (
        _key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        stored = await mutate(undefined)
        return stored
      },
    } as never)
    const store = credentialStoreFrom(ctx)
    const grant = {
      type: 'oauth' as const,
      access: 'at',
      refresh: 'rt',
      expires: 42,
      enterpriseUrl: undefined,
      nested: { keep: 'x', drop: undefined },
      list: ['a', undefined, 'b'],
    } as unknown as Credential

    await store.modify('github-copilot', () => Promise.resolve(grant))

    expect(stored).toEqual({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access: 'at',
        refresh: 'rt',
        expires: 42,
        nested: { keep: 'x' },
        list: ['a', null, 'b'],
      },
    })
  })

  it('addresses the scoped record through the existing credential key', () => {
    expect(recordKeyFor('github-copilot')).toBe(credentialKey('llm-pi-ai', 'github-copilot'))
  })
})

describe('pi-ai credential store signals and serialization', () => {
  /** A record store double that serializes modifyRecord through a chain. */
  function serializedProvider(ctx: Context, map = new Map<CredentialKey, CredentialRecord>()) {
    let chain: Promise<unknown> = Promise.resolve()
    return ctx.provide('credentials', {
      readRecord: (key: CredentialKey) => Promise.resolve(map.get(key)),
      listRecords: () => Promise.resolve([...map].map(([key, r]) => ({ key, kind: r.kind }))),
      deleteRecord: (key: CredentialKey) => {
        chain = chain.then(() => { map.delete(key) })
        return chain.then(() => undefined)
      },
      modifyRecord: (
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const work = chain.then(async () => {
          const next = await mutate(map.get(key))
          if (next !== undefined) map.set(key, next)
          return next ?? map.get(key)
        })
        chain = work.then(() => undefined, () => undefined)
        return work
      },
    } as never)
  }

  it('refuses read, list, and delete against a withdrawn signal before touching storage', async () => {
    const ctx = new Context()
    serializedProvider(ctx)
    const store = credentialStoreFrom(ctx)
    const signal = AbortSignal.abort()

    await expect(store.read('openai-codex', { signal })).rejects.toThrow()
    await expect(store.list({ signal })).rejects.toThrow()
    await expect(store.delete('openai-codex', { signal })).rejects.toThrow()
    await expect(store.modify('openai-codex', () => Promise.resolve(undefined), { signal }))
      .rejects.toThrow()
  })

  it('keeps the provider serialization and refuses an aborted mutation without writing', async () => {
    const ctx = new Context()
    serializedProvider(ctx)
    const store = credentialStoreFrom(ctx)
    const gate = Promise.withResolvers<undefined>()
    const firstIn = Promise.withResolvers<undefined>()
    const signal = new AbortController()

    // The first modify holds the chain; the second queues behind it.
    const first = store.modify('openai-codex', async () => {
      firstIn.resolve(undefined)
      await gate.promise
      return { type: 'oauth', access: 'first', refresh: 'r', expires: 1 }
    })
    const second = store.modify('openai-codex', async (current) => {
      expect(current).toMatchObject({ access: 'first' })
      return { type: 'oauth', access: 'second', refresh: 'r2', expires: 1 }
    }, { signal: signal.signal })
    await firstIn.promise
    signal.abort()
    gate.resolve(undefined)
    await first
    await expect(second).rejects.toThrow()
    expect(await store.read('openai-codex')).toMatchObject({ access: 'first' })
  })
})
