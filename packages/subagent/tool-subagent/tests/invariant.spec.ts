import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as ToolInvariant from '../src/invariant.ts'
import '../src/model-selection-state.ts'

const selectableSchema = {
  name: 'subagent',
  parameters: { properties: { provider: {}, model: {}, reasoning_effort: {} } },
}
const listSchema = { name: 'list_subagent_models', parameters: { properties: {} } }

function agent(withPolicy: boolean): { session: Session } {
  const session = Session.create(SessionId(withPolicy ? 'policy-agent' : 'missing-policy-agent'))
  if (withPolicy) {
    session.append('subagent/model-selection-policy', {
      allowedModels: [{ provider: 'alpha', model: 'fast' }],
    })
  }
  return { session }
}

async function run(withPolicy: boolean, schemas: readonly object[]): Promise<unknown> {
  const ctx = new Context()
  ctx.provide('tools', { schemas: () => schemas } as never)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ToolInvariant)
  const payload = {
    agent: agent(withPolicy),
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  return ctx.waterfall(ctx as never, 'agent/pre-step', payload as never, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
}

describe('tool-subagent model-selection invariant', () => {
  it('rejects a model-selectable definition without a durable policy', async () => {
    await expect(run(false, [selectableSchema, listSchema]))
      .rejects.toThrow(InvariantError)
  })

  it('accepts a complete model-selectable definition with its policy', async () => {
    await expect(run(true, [selectableSchema, listSchema]))
      .resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('rejects a policy or discovery half without both model-facing definitions', async () => {
    await expect(run(true, [selectableSchema])).rejects.toThrow(/require a durable policy/)
    await expect(run(true, [listSchema])).rejects.toThrow(/require a durable policy/)
  })
})
