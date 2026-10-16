import { describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  deliverSubagentPrompt,
  hasPendingDirectChildren,
  isAdjacentAgentSendMessageTool,
  markAdjacentAgentSendMessageTool,
  queueHostSubagentPrompt,
  steerHostSubagentPrompt,
  subagentPendingDirectChildren,
} from '../src/internal.ts'

/**
 * The host-protocol adapters are one typed face over the runtime's private
 * delivery method: each forwards verbatim and selects its delivery mode.
 */
describe('host prompt adapters', () => {
  it.each(['queue', 'steer'] as const)('forwards the %s delivery mode through the runtime symbol', async (delivery) => {
    const accepted = MessageId('m-1')
    const deliver = vi.fn(async () => accepted)
    const runtime = { [deliverSubagentPrompt]: deliver } as never as SubagentRuntime
    const parent = {} as Agent
    const childId = SessionId('child')
    const content = [{ type: 'text' as const, text: 'follow up' }]
    const source = { kind: 'user' as const }
    const signal = new AbortController().signal

    const call = delivery === 'queue' ? queueHostSubagentPrompt : steerHostSubagentPrompt
    await expect(call(runtime, parent, childId, content, source, signal)).resolves.toBe(accepted)
    expect(deliver).toHaveBeenCalledWith(parent, childId, content, source, signal, delivery)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})

describe('pending direct children probe', () => {
  it('forwards the exact live parent through the runtime symbol', () => {
    const parent = {} as Agent
    const probe = vi.fn((agent: Agent) => agent === parent)
    const runtime = { [subagentPendingDirectChildren]: probe } as never

    expect(hasPendingDirectChildren(runtime, parent)).toBe(true)
    expect(probe).toHaveBeenCalledWith(parent)
    expect(hasPendingDirectChildren(runtime, {} as Agent)).toBe(false)
  })
})

describe('adjacent-agent send_message marker', () => {
  it('round-trips the internal identity without changing the visible schema', () => {
    const definition = { name: 'send_message' } as ToolDefinition
    expect(markAdjacentAgentSendMessageTool(definition)).toBe(definition)
    expect(isAdjacentAgentSendMessageTool(definition)).toBe(true)
    expect(Object.keys(definition)).toEqual(['name'])
  })

  it('rejects unmarked and absent definitions', () => {
    expect(isAdjacentAgentSendMessageTool({ name: 'send_message' } as ToolDefinition)).toBe(false)
    expect(isAdjacentAgentSendMessageTool(undefined)).toBe(false)
  })
})
