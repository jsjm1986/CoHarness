import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { clientInspectProviders } from '../src/client/providers.ts'

const QUERY_CONTEXT = { signal: new AbortController().signal, sessionId: 'providers-spec' as SessionId }

function provider(ctx: Context, id: string) {
  const found = clientInspectProviders(ctx).find(item => item.manifest.id === id)
  if (found === undefined) throw new Error(`${id} inspect provider is missing`)
  return found
}

describe('Client inspect providers', () => {
  it('registers the Service/Event/Builtin/Slots/Theme provider set', () => {
    const ctx = new Context()
    const ids = clientInspectProviders(ctx).map(item => item.manifest.id)
    expect(ids).toEqual(expect.arrayContaining(['Service', 'Event', 'Builtin', 'Slots', 'Theme']))
    for (const item of clientInspectProviders(ctx)) {
      expect(item.manifest.methods.length).toBeGreaterThan(0)
    }
  })

  it('rejects unknown methods on a provider', async () => {
    const ctx = new Context()
    await expect(provider(ctx, 'Builtin').query('notAMethod', undefined, QUERY_CONTEXT)).rejects.toThrow('unknown Builtin inspect method')
  })

  it('returns the static builtin list without services', async () => {
    const ctx = new Context()
    const result = await provider(ctx, 'Builtin').query('listBuiltins', undefined, QUERY_CONTEXT) as { builtins: JsonValue[] }
    expect(result.builtins.length).toBeGreaterThan(0)
  })

  it('serves compact live Slot trees and the selected exact contract', async () => {
    const ctx = new Context()
    const child = { name: 'root.child', kind: 'single', scope: 'root', children: [], occupants: [], declaredBy: 'test' }
    const root = { name: 'root', kind: 'root', scope: 'root', children: [child], occupants: [{ plugin: 'x' }] }
    const snapshotCalls: (string | undefined)[] = []
    ctx.provide('slots', {
      snapshot: (requested?: string) => {
        snapshotCalls.push(requested)
        return requested === undefined || requested === 'root' ? [root] : []
      },
    } as never)
    const slots = provider(ctx, 'Slots')

    const all = await slots.query('listSubTree', undefined, QUERY_CONTEXT) as {
      trees: { name: string; children: { name: string }[] }[]
      requestedRoot?: unknown
      selected?: unknown
    }
    expect(all.trees[0]?.name).toBe('root')
    expect(all.trees[0]?.children[0]?.name).toBe('root.child')
    expect(all.requestedRoot).toBeUndefined()
    expect(all.selected).toBeUndefined()

    const exact = await slots.query('listSubTree', { root: 'root' }, QUERY_CONTEXT) as {
      requestedRoot: { name: string; available: boolean }
      selected: { name: string; occupants: unknown[] }
    }
    expect(exact.requestedRoot).toEqual({ name: 'root', available: true })
    expect(exact.selected.name).toBe('root')
    expect(exact.selected.occupants).toHaveLength(1)

    const missing = await slots.query('listSubTree', { root: 'missing' }, QUERY_CONTEXT) as {
      requestedRoot: { name: string; available: boolean }
      selected?: unknown
    }
    expect(missing.requestedRoot).toEqual({ name: 'missing', available: false })
    expect(missing.selected).toBeUndefined()
    expect(snapshotCalls).toEqual([undefined, 'root', 'missing'])
  })

  it('fails loudly when the Slots service is absent', async () => {
    const ctx = new Context()
    await expect(async () => provider(ctx, 'Slots').query('listSubTree', undefined, QUERY_CONTEXT)).rejects.toThrow('Slots service is not running')
  })

  it('serves theme tokens through the Theme service and fails when absent', async () => {
    const ctx = new Context()
    await expect(provider(ctx, 'Theme').query('listTokens', undefined, QUERY_CONTEXT)).rejects.toThrow('Theme service is not running')
    const tokens = [{ name: 'accent', dark: false }]
    ctx.provide('theme', { exportInspectTokens: () => tokens } as never)
    const result = await provider(ctx, 'Theme').query('listTokens', undefined, QUERY_CONTEXT) as { tokens: unknown[] }
    expect(result.tokens).toEqual(tokens)
  })
})
