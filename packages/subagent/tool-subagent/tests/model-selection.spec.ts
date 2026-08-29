import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import {
  assertAllowedModelRoutes, assertAllowedModelSelection, hasDelegationModelRequest,
  requestedAgentOptions,
} from '../src/model-selection.ts'

describe('subagent model selection', () => {
  it('merges a complete route and clears inherited effort when switching models', () => {
    const parent: AgentOptions = { provider: 'parent', model: 'p', reasoningEffort: ReasoningEffortId('high') }
    expect(requestedAgentOptions(parent, undefined, { provider: 'child', model: 'c' }, true)).toEqual({
      provider: 'child', model: 'c',
    })
    expect(requestedAgentOptions(parent, undefined, { provider: 'parent', model: 'p', reasoning_effort: 'max' }, true))
      .toEqual({ provider: 'parent', model: 'p', reasoningEffort: ReasoningEffortId('max') })
  })

  it('rejects partial, empty, disabled, and disallowed selections', () => {
    const parent: AgentOptions = { provider: 'parent', model: 'p' }
    expect(() => requestedAgentOptions(parent, undefined, { provider: 'x' }, true)).toThrow('must be supplied together')
    expect(() => requestedAgentOptions(parent, undefined, { provider: '', model: 'x' }, true)).toThrow('non-empty')
    expect(() => requestedAgentOptions(parent, undefined, { model: 'x' }, false)).toThrow('disabled')
    const policy = { routes: [{ provider: 'allowed', model: 'm' }] }
    expect(() => assertAllowedModelSelection(policy, parent, { provider: 'denied', model: 'm' }, { provider: 'denied', model: 'm' }))
      .toThrow('not allowed')
    expect(() => assertAllowedModelSelection(undefined, parent, { provider: 'x', model: 'm' }, { provider: 'x', model: 'm' }))
      .toThrow('no allowed-route policy')
  })

  it('validates route allowlists and detects explicit requests', () => {
    expect(hasDelegationModelRequest({})).toBe(false)
    expect(hasDelegationModelRequest({ reasoning_effort: 'high' })).toBe(true)
    expect(() => assertAllowedModelRoutes([{ provider: 'a', model: 'm' }, { provider: 'a', model: 'm' }]))
      .toThrow('repeats route')
    expect(() => assertAllowedModelRoutes([{ provider: '', model: 'm' }])).toThrow('non-empty')
  })
})
