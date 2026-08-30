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
