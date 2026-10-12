/**
 * Plan extraction and address identities: `exit_plan_mode` arguments read
 * from native `tool/call`, PTC dispatch start, and PTC settlement events;
 * saved resource addresses round-trip Session and direct-subagent identity.
 */
import { describe, expect, it } from 'vitest'
import type {
  ChatSnapshot, ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { planAddress, parsePlanAddress, submittedPlan, type SubmittedPlan } from '../src/client/plan.ts'
import { plansForTurn, plansSourceFor, submittedPlanDefinition } from '../src/client/plan-definition.ts'
import { isReviewPreviewAddress, parseReviewPreviewAddress, reviewPreviewAddress } from '../src/client/review-preview.ts'
import { planFailureLine } from '../src/client/failure-line.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: 1_700_000_000_000 + seq, type, data } as ConversationEventInput['event'], view: undefined }
}

function planEvent(plan = '# Draft\nbody'): string {
  return JSON.stringify({ plan })
}

class EventDefs {
  entries(): readonly ConversationNodeDefinition[] { return [submittedPlanDefinition] }
  fallbackEntry(): ConversationNodeDefinition | undefined { return undefined }
}

class ViewDefs {
  entries(): readonly ConversationViewDefinition[] { return [chatViewDefinition] }
}

function assemble(entries: readonly ConversationEventInput[]): ChatSnapshot {
  const assembler = new ConversationNodeAssembler(new EventDefs(), new ViewDefs())
  assembler.replaceWindow(entries, false)
  assembler.flush()
  const snapshot = assembler.snapshot('chat') as ChatSnapshot | undefined
  if (snapshot === undefined) throw new Error('chat view was not registered')
  return snapshot
}

describe('submittedPlan', () => {
  it('reads the call identity, Markdown, and first heading from a native tool/call', () => {
    const plan = submittedPlan(at(1, 'tool/call', {
      turn: 1, step: 1, callId: 'call-1', name: 'exit_plan_mode', arguments: planEvent(),
    }).event)
    expect(plan).toEqual({ callId: 'call-1', markdown: '# Draft\nbody', title: 'Draft' })
  })

  it('accepts PTC dispatch start and settlement events addressed by subCallId', () => {
    const data = {
      rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:2',
      name: 'exit_plan_mode', arguments: { plan: '# Ship\nx' },
    }
    expect(submittedPlan(at(2, 'tool/ptc-dispatch-start', data).event)?.callId).toBe('root:ptc:2')
    expect(submittedPlan(at(3, 'tool/ptc-dispatch', { ...data, isError: false, content: [] }).event)?.title).toBe('Ship')
  })

  it('rejects unrelated types, other tools, and malformed arguments without throwing', () => {
    const cases: readonly ConversationEventInput[] = [
      at(1, 'tool/result', { turn: 1, step: 1, message: {} }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'write_file', arguments: planEvent() }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: '', name: 'exit_plan_mode', arguments: planEvent() }),
      at(4, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'exit_plan_mode', arguments: 'not json' }),
      at(5, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'exit_plan_mode', arguments: '[]' }),
      at(6, 'tool/call', {
        turn: 1, step: 1, callId: 'c', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: 42 }),
      }),
      at(7, 'tool/call', {
        turn: 1, step: 1, callId: 'c', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: 'no heading' }),
      }),
      at(8, 'tool/ptc-dispatch-start', {
        rootCallId: 'r', parentCallId: 'r', subCallId: '', name: 'exit_plan_mode', arguments: { plan: '# x' },
      }),
      at(9, 'tool/ptc-dispatch', {
        rootCallId: 'r', parentCallId: 'r', subCallId: 's', name: 'exit_plan_mode',
        arguments: 'a string', isError: false, content: [],
      }),
    ]
    for (const input of cases) expect(submittedPlan(input.event)).toBeUndefined()
  })
})

describe('planAddress', () => {
  it('round-trips a plain Session plan address', () => {
    const address = planAddress({ session: { kind: 'session', sessionId: 's-1' as SessionId }, callId: 'c-1' as ToolCallId })
    expect(address).toBe('dsh-resource://plan/s-1/c-1')
    expect(parsePlanAddress(address)).toEqual({ session: { kind: 'session', sessionId: 's-1' }, callId: 'c-1' })
  })

  it('round-trips subagent identity and percent-encodes every component', () => {
    const address = planAddress({
      session: { kind: 'subagent', parentSessionId: 'p/1' as SessionId, childSessionId: 'c?1' as SessionId, mode: 'continuable' },
      callId: 'call#1' as ToolCallId,
    })
    expect(address).toBe('dsh-resource://plan/subagent/p%2F1/c%3F1/continuable/call%231')
    expect(parsePlanAddress(address)).toEqual({
      session: { kind: 'subagent', parentSessionId: 'p/1', childSessionId: 'c?1', mode: 'continuable' },
      callId: 'call#1',
    })
  })

  it('rejects foreign schemes, missing parts, empty components, and bad modes', () => {
    for (const address of [
      'https://example.com/plan/s/c',
      'dsh-resource://plan/only-one',
      'dsh-resource://plan/a/b/c',
      'dsh-resource://plan//c',
      'dsh-resource://plan/subagent/p/c/durable/x',
      'dsh-resource://plan/subagent/p/c/one-shot',
      'dsh-resource://plan/subagent/p/c/one-shot/x/extra',
      'dsh-resource://plan/%E0%A4%A/c',
    ]) expect(parsePlanAddress(address)).toBeUndefined()
  })

  it('accepts the unknown-mode form persisted by other builds', () => {
    expect(parsePlanAddress('dsh-resource://plan/subagent/p/c/unknown/x')).toEqual({
      session: { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'unknown' },
      callId: 'x',
    })
  })
})

describe('review preview addresses', () => {
  it('round-trips the owning Session and rejects malformed forms', () => {
    const address = reviewPreviewAddress('s-1' as SessionId, 'window:req-1')
    expect(isReviewPreviewAddress(address)).toBe(true)
    expect(parseReviewPreviewAddress(address)).toEqual({ sessionId: 's-1' })
    for (const address of [
      'dsh-resource://plan/s/c',
      'dsh-resource://plan-review/only',
      'dsh-resource://plan-review/a/b/c',
      'dsh-resource://plan-review//k',
    ]) {
      expect(isReviewPreviewAddress(address)).toBe(false)
      expect(parseReviewPreviewAddress(address)).toBeUndefined()
    }
  })
})

describe('submittedPlanDefinition', () => {
  const planCall = (seq: number, callId: string) => at(seq, 'tool/call', {
    turn: 1, step: 1, callId, name: 'exit_plan_mode', arguments: planEvent(`# Plan ${callId}`),
  })

  it('materializes one hidden Node per invocation under its resolved Turn', () => {
    const snapshot = assemble([
      at(1, 'turn/start', { turn: 1 }),
      planCall(2, 'c-1'),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'other', name: 'write_file', arguments: '{}' }),
      planCall(4, 'c-2'),
      at(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(6, 'turn/start', { turn: 2 }),
      at(7, 'tool/call', { turn: 2, step: 1, callId: 'c-3', name: 'exit_plan_mode', arguments: planEvent('# Later') }),
      at(8, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    const plans = snapshot.nodes.values().filter(node => node.kind === 'submitted-plan')
    expect(plans.map(node => node.id)).toEqual(['c-1', 'c-2', 'c-3'])
    for (const node of plans) expect(node.visibility).toBe('hidden')
    expect(plansForTurn(snapshot, 1).map((plan: SubmittedPlan) => plan.callId)).toEqual(['c-1', 'c-2'])
    expect(plansForTurn(snapshot, 2).map((plan: SubmittedPlan) => plan.title)).toEqual(['Later'])
    expect(plansForTurn(snapshot, 99)).toEqual([])
  })

  it('keeps the original card when a PTC settlement updates the invocation', () => {
    const dispatch = { rootCallId: 'r', parentCallId: 'r', subCallId: 'r:ptc:1', name: 'exit_plan_mode', arguments: { plan: '# PTC' } }
    const snapshot = assemble([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/ptc-dispatch-start', dispatch),
      at(3, 'tool/ptc-dispatch', { ...dispatch, isError: false, content: [] }),
      at(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const plans = snapshot.nodes.values().filter(node => node.kind === 'submitted-plan')
    expect(plans).toHaveLength(1)
    expect(plans[0]?.id).toBe('r:ptc:1')
    expect(plans[0]?.anchorSeq).toBe(2)
    expect((plans[0]?.data as SubmittedPlan).title).toBe('PTC')
  })

  it('drops invocations whose events never produced a plan', () => {
    const snapshot = assemble([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/ptc-dispatch-start', { rootCallId: 'r', parentCallId: 'r', subCallId: 'x', name: 'other_tool', arguments: {} }),
      at(3, 'tool/ptc-dispatch', {
        rootCallId: 'r', parentCallId: 'r', subCallId: 'x', name: 'other_tool',
        arguments: {}, isError: false, content: [],
      }),
      at(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(snapshot.nodes.values().filter(node => node.kind === 'submitted-plan')).toHaveLength(0)
  })
})

describe('plansSourceFor', () => {
  it('republishes only when the Turn plan list changes', () => {
    const snapshot = assemble([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'c-1', name: 'exit_plan_mode', arguments: planEvent() }),
      at(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const session = {
      getSnapshot: () => ({ chat: snapshot }),
      subscribe: () => () => {},
    }
    const source = plansSourceFor(session as never, 1)
    const first = source.getSnapshot()
    expect(first.map(plan => plan.callId)).toEqual(['c-1'])
    expect(source.getSnapshot()).toBe(first)
  })
})

describe('planFailureLine', () => {
  it('localizes plan-owned codes and passes external diagnostics through', () => {
    expect(planFailureLine(t, { code: 'plan/invalid-address', message: 'wire' })).toBe(zh['preview.invalidAddress'])
    expect(planFailureLine(t, { code: 'plan/unavailable', message: 'wire' })).toBe(zh['preview.historyUnavailable'])
    expect(planFailureLine(t, { code: 'plan/not-found', message: 'wire' })).toBe(zh['preview.notFound'])
    expect(planFailureLine(t, { code: 'session/not-found', message: 'gone' })).toBe('gone')
  })
})
