/**
 * Renderer invariant companion: the 'slots/changed' emission-order audit —
 * a fired key must already carry a bumped version (emission follows the
 * applied mutation), bogus payloads fail loud, foreign events pass. The
 * slots service is stubbed at `ctx.provide` because the emission-order
 * guarantee itself belongs to the runtime service's own companion spec.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RendererInvariant from '../src/invariant.ts'

const emit = (ctx: Context, event: string, ...args: unknown[]): void => {
  ;(ctx.emit as (event: string, ...args: unknown[]) => void)(event, ...args)
}

async function setup(versions?: Map<string, number>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  if (versions !== undefined) {
    ctx.provide('slots', { getVersion: (key: string) => versions.get(key) ?? 0 })
  }
  await ctx.plugin(RendererInvariant).await()
  return ctx
}

describe('renderer slots/changed invariant', () => {
  it('passes foreign events and a mutation-then-emission sequence', async () => {
    const versions = new Map<string, number>()
    const ctx = await setup(versions)
    expect(() => { emit(ctx, 'unrelated/event', 'x') }).not.toThrow()
    // A legitimate sequence bumps the version first; the audit sees > 0.
    versions.set('root', 1)
    expect(() => { emit(ctx, 'slots/changed', 'root') }).not.toThrow()
  })

  it('fails loud on a missing key and on an emission with no applied mutation', async () => {
    const ctx = await setup(new Map())
    expect(() => { emit(ctx, 'slots/changed', '') }).toThrow(/without a slot key/)
    expect(() => { emit(ctx, 'slots/changed', 42) }).toThrow(/without a slot key/)
    // Hand-emitted key that never saw a mutation: version 0 → violation.
    expect(() => { emit(ctx, 'slots/changed', 'never-mutated') })
      .toThrow(/before any mutation bumped its version/)
  })

  it('stays quiet when no slots service is mounted (nothing to audit against)', async () => {
    const ctx = await setup()
    expect(() => { emit(ctx, 'slots/changed', 'any-key') }).not.toThrow()
  })
})
