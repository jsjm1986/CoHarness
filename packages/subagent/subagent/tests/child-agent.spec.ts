import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ExecutionInheritance, ExecutionInputId } from '@deepseek-ai/dsh-execution-authority'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendDelegatedPolicyOverrides, captureDelegatedPolicyOverrides, resolveChildAgentOptions } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('delegated execution policy', () => {
  it('retains explicit Auto identity and the captured participants in the child log', () => {
    const parent = parentAgent()
    const ctx = new Context()
    const scope: ExecutionInheritance = { parentSessionId: parent.id,
      inputs: ['00000000-0000-4000-8000-000000000001' as ExecutionInputId], primaryActorUserId: 1, unverifiedHistory: false }
    ctx.provide('executionAuthority', { capture: () => scope } as never)
    ctx.provide('permissionPresets', { current: () => 'auto' } as never)
    ctx.provide('sandboxPolicy', { overrideOf: () => 'danger-full-access' } as never)
    ctx.provide('approval', {} as never)
    const overrides = captureDelegatedPolicyOverrides({ ...parent, ctx })
    const child = Session.create(SessionId('child'))
    appendDelegatedPolicyOverrides(child, overrides)
    expect(child.ownEvents().map(event => [event.type, event.data])).toEqual([
      ['gateway/execution', { kind: 'inherit', scope }],
      ['sandbox/mode', { mode: 'danger-full-access', source: 'delegation' }],
      ['approval/policy', { policy: 'never', source: 'delegation' }],
      ['permission/preset', { preset: 'auto', origin: 'selection' }],
    ])
  })

  it('refuses delegation from a managed deployment with no authority provider', () => {
    const ctx = new Context()
    ctx.provide('executionAuthorityRequired', true)
    expect(() => captureDelegatedPolicyOverrides({ ...parentAgent(), ctx })).toThrow(/authorization provider/)
  })
})
