import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-api-remotes/client'
import { clientInspectProviders } from '../src/client/providers.ts'

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
    await expect(provider(ctx, 'Builtin').query('notAMethod', undefined)).rejects.toThrow('unknown Builtin inspect method')
  })

  it('returns the static builtin list without services', async () => {
    const ctx = new Context()
    const result = await provider(ctx, 'Builtin').query('listBuiltins', undefined) as { builtins: JsonValue[] }
    expect(result.builtins.length).toBeGreaterThan(0)
  })

  it('serves compact live Slot trees and the selected exact contract', async () => {
    const ctx = new Context()
    const child = { name: 'root.child', kind: 'single', scope: 'root', children: [], occupants: [], declaredBy: 'test' }
    const root = { name: 'root', kind: 'root', scope: 'root', children: [child], occupants: [{ plugin: 'x' }] }
    ctx.provide('slots', { snapshot: () => [root] } as never)
    const slots = provider(ctx, 'Slots')

    const all = await slots.query('listSubTree', undefined) as {
      trees: { name: string; children: { name: string }[] }[]
      requestedRoot?: unknown
      selected?: unknown
    }
    expect(all.trees[0]?.name).toBe('root')
    expect(all.trees[0]?.children[0]?.name).toBe('root.child')
    expect(all.requestedRoot).toBeUndefined()
    expect(all.selected).toBeUndefined()

    const exact = await slots.query('listSubTree', { root: 'root' }) as {
      requestedRoot: { name: string; available: boolean }
      selected: { name: string; occupants: unknown[] }
    }
    expect(exact.requestedRoot).toEqual({ name: 'root', available: true })
    expect(exact.selected.name).toBe('root')
    expect(exact.selected.occupants).toHaveLength(1)
  })

  it('fails loudly when the Slots service is absent', async () => {
    const ctx = new Context()
    await expect(async () => provider(ctx, 'Slots').query('listSubTree', undefined)).rejects.toThrow('Slots service is not running')
  })

  it('serves theme tokens through the Theme service and fails when absent', async () => {
    const ctx = new Context()
    await expect(provider(ctx, 'Theme').query('listTokens', undefined)).rejects.toThrow('Theme service is not running')
    const tokens = [{ name: 'accent', dark: false }]
    ctx.provide('theme', { exportInspectTokens: () => tokens } as never)
    const result = await provider(ctx, 'Theme').query('listTokens', undefined) as { tokens: unknown[] }
    expect(result.tokens).toEqual(tokens)
  })
})
