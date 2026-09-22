// contextBreakdown projection: heuristic system/tools/message composition,
// plus the shared estimator's pricing branches.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, SystemMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ContextBreakdownProjection } from '@deepseek-ai/dsh-token-meter/client'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { contextBreakdownProjectionDefinition } from '../src/breakdown-projection.ts'
import {
  estimateContent,
  estimateMessage,
  estimateSystemMessage,
  estimateToolsTokens,
} from '../src/estimate.ts'

const CONFIG = { provider: 'test', model: 'test-model' }

const TOOLS: ToolSchema[] = [{
  name: 'bash',
  description: 'run a command',
  parameters: { type: 'object', properties: {} },
}]

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

const projected = (ctx: Context, session: Session): ContextBreakdownProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.contextBreakdown
  if (value === undefined) throw new Error('contextBreakdown projection is not registered')
  return value
}

function appendUser(session: Session, text: string): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** One system prompt on the surface, attributed to a plugin producer. */
function systemMessage(text: string): SystemMessage {
  return createMessage({
    role: 'system',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

/**
 * Meter one upcoming replacement the way compaction-basic does: price the
 * replaced span from the measurement service's own nodes and log the
 * shadow-price event directly before the replace.
 */
function appendSummaryMeter(ctx: Context, session: Session, start: SessionSeqType, end: SessionSeqType): void {
  const nodes = ctx.tokenMeter.measure(session).nodes
  const startIdx = nodes.findIndex(node => node.seq === start)
  const endIdx = nodes.findIndex(node => node.seq === end)
  const shadowed = nodes.slice(startIdx, endIdx + 1)
  session.append('compaction/summary', {
    compactionId: CompactionId('context-breakdown-summary'),
    summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start, end },
    shadowedSeqs: shadowed.map(node => node.seq),
    shadowedTokenCount: shadowed.reduce((total, node) => total + node.tokens, 0),
    provider: 'mock',
    model: 'mock',
  })
}

describe('contextBreakdown session projection', () => {
  it('serves zeros for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('prices the newest envelope and system head last-wins and pushes no change for a restated one', async () => {
    const { ctx, session } = await harness()
    const system = systemMessage('You are terse.')
    const systemSeq = session.append('system/message', {
      turn: 1, step: 1, message: system,
    }, { surfaceOp: 'append' }).seq
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'initial',
    })
    expect(projected(ctx, session)).toEqual({
      systemTokens: estimateSystemMessage(system),
      toolsTokens: estimateToolsTokens({ config: CONFIG, tools: TOOLS }),
      messageTokens: 0,
    })

    const changed: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => { changed.push(key) })
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'change',
    })
    session.append('todo/write', { todos: [] })
    expect(changed).not.toContain('contextBreakdown')

    // An empty system rewrite and a tool-less envelope price back to zero.
    session.append('system/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'system',
        content: [],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    }, {
      surfaceOp: { op: 'replace', startSeq: systemSeq, endSeq: systemSeq },
      sourceEventSeqs: [systemSeq],
    })
    session.append('request/header', { header: { config: CONFIG }, reason: 'change' })
    expect(projected(ctx, session)).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('prices an in-history chain: effective prompt in system, superseded nodes in messages', async () => {
    const { ctx, session } = await harness()
    const head = systemMessage('prompt version one')
    session.append('system/message', {
      turn: 1, step: 1, message: head,
    }, { surfaceOp: 'append' })
    const tail = systemMessage('prompt version two, longer')
    const tailSeq = session.append('system/message', {
      turn: 1, step: 2, message: tail,
    }, { surfaceOp: 'append' }).seq
    // The newest nonempty system node is the effective prompt; the superseded
    // head stays model-visible and belongs to the message figure.
    expect(projected(ctx, session)).toEqual({
      systemTokens: estimateSystemMessage(tail),
      toolsTokens: 0,
      messageTokens: estimateSystemMessage(head),
    })

    // Emptying the tail drops its price everywhere; the head becomes the
    // effective prompt again.
    session.append('system/message', {
      turn: 1, step: 3,
      message: createMessage({
        role: 'system', content: [], source: { kind: 'plugin', plugin: 'test' },
      }),
    }, {
      surfaceOp: { op: 'replace', startSeq: tailSeq, endSeq: tailSeq },
      sourceEventSeqs: [tailSeq],
    })
    expect(projected(ctx, session)).toEqual({
      systemTokens: estimateSystemMessage(head),
      toolsTokens: 0,
      messageTokens: 0,
    })

    // A newer in-history tail takes effect again, then a metered compaction
    // shadows it: its conserved price lands in the summary's replacement, the
    // head keeps the system figure, and the summary prices as a message.
    const tail2 = systemMessage('prompt version three')
    const tail2Seq = session.append('system/message', {
      turn: 1, step: 4, message: tail2,
    }, { surfaceOp: 'append' }).seq
    const summary = createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    appendSummaryMeter(ctx, session, tail2Seq, tail2Seq)
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', startSeq: tail2Seq, endSeq: tail2Seq },
      sourceEventSeqs: [tail2Seq],
    })
    expect(projected(ctx, session)).toEqual({
      systemTokens: estimateSystemMessage(head),
      toolsTokens: 0,
      messageTokens: estimateMessage(summary),
    })
  })

  it('sums surface appends and skips an empty-content assistant message', async () => {
    const { ctx, session } = await harness()
    appendUser(session, 'abcd')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 9, outputTokens: 0 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    // 'abcd' prices to 9 (1 text + 4 block + 4 role); the usage-only assistant
    // message derives to no transcript entry and adds nothing.
    expect(projected(ctx, session).messageTokens).toBe(9)
  })

  it('shrinks the message figure when a metered replacement compacts the surface', async () => {
    const { ctx, session } = await harness()
    const first = appendUser(session, 'before compaction, a longer message')
    const second = appendUser(session, 'and a second entry')
    const summary = createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    appendSummaryMeter(ctx, session, first, second)
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: second },
      sourceEventSeqs: [first, second],
    })
    expect(projected(ctx, session).messageTokens).toBe(estimateMessage(summary))
  })

  it('keeps the message figure equal to the service result across appends and a compaction', async () => {
    const { ctx, session } = await harness()
    // The panel's composition rows and `measure()` answer the same question in
    // the same vocabulary; one shared fold is what makes that true.
    const agree = (): number => {
      const messageTokens = projected(ctx, session).messageTokens
      expect(messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
      return messageTokens
    }
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'initial',
    })
    expect(agree()).toBe(0)

    const question = appendUser(session, 'a first question, long enough to price above zero')
    session.append('step/start', { turn: 1, step: 1 })
    const answer = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a considered answer' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 40, outputTokens: 7 },
    }, { surfaceOp: 'append' }).seq
    session.append('step/end', { turn: 1, step: 1 })
    const grown = agree()
    expect(grown).toBeGreaterThan(0)

    appendSummaryMeter(ctx, session, question, answer)
    // The armed shadow price must not move the published figure by itself.
    expect(agree()).toBe(grown)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: question, endSeq: answer },
      sourceEventSeqs: [question, answer],
    })
    expect(agree()).toBeLessThan(grown)
  })

  it('folds a replacement without a claim at zero and fails on a mismatched claim', () => {
    const definition = contextBreakdownProjectionDefinition
    const replace = (start: SessionSeq, end: SessionSeq): SessionEvent => ({
      type: 'user/message',
      seq: SessionSeq(9),
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [start, end],
    } as unknown as SessionEvent)
    const append = (seq: SessionSeq): SessionEvent => ({
      type: 'user/message',
      seq,
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    } as unknown as SessionEvent)
    const meter = (start: SessionSeq, end: SessionSeq, seq: SessionSeq): SessionEvent => ({
      type: 'compaction/prune',
      seq,
      time: 0,
      data: {
        shadowedRange: { start, end },
        shadowedSeqs: [start, end],
        shadowedTokenCount: 5,
      },
    } as unknown as SessionEvent)
    let state = definition.init()
    state = definition.apply(state, append(SessionSeq(1)))
    state = definition.apply(state, append(SessionSeq(3)))
    // No metering event: the replacement contributes zero instead of throwing.
    expect(definition.wire.view(definition.apply(state, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens)
    // An adjacent claim for another range contradicts the replacement.
    const mismatched = definition.apply(state, meter(SessionSeq(1), SessionSeq(1), SessionSeq(8)))
    expect(() => definition.apply(mismatched, replace(SessionSeq(1), SessionSeq(3))))
      .toThrow('no adjacent shadow price')
    // A claim expires after one intervening event, so replacement delta is zero.
    let expired = definition.apply(state, meter(SessionSeq(1), SessionSeq(3), SessionSeq(8)))
    expired = definition.apply(expired, {
      type: 'session/end-seed', seq: SessionSeq(9), time: 0, data: {},
    })
    expect(definition.wire.view(definition.apply(expired, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens)
    // The armed claim prices exactly the next event's matching replacement.
    const armed = definition.apply(state, meter(SessionSeq(1), SessionSeq(3), SessionSeq(8)))
    expect(definition.wire.view(definition.apply(armed, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens - 5 + estimateMessage(
        createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      ))
  })

  it('treats a citation-less replace as covering nothing and reseats a rewritten system node', () => {
    const definition = contextBreakdownProjectionDefinition
    const systemAppend = (seq: SessionSeq, text: string): SessionEvent => ({
      type: 'system/message',
      seq,
      time: 0,
      data: { turn: 1, step: 1, message: systemMessage(text) },
      surfaceOp: 'append',
    } as unknown as SessionEvent)
    let state = definition.init()
    state = definition.apply(state, systemAppend(SessionSeq(1), 'first prompt'))
    state = definition.apply(state, systemAppend(SessionSeq(2), 'second prompt, longer'))
    const before = definition.wire.view(state)

    // A committed replace always cites its shadowed nodes, but the citation
    // field is optional on the wire: an uncited replace covers nothing, so a
    // live system entry survives it untouched.
    const uncited = {
      type: 'user/message',
      seq: SessionSeq(3),
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
    } as unknown as SessionEvent
    expect(definition.wire.view(definition.apply(state, uncited)).systemTokens).toBe(before.systemTokens)

    // A system write that retires an in-history node is reseated where the
    // oldest covered entry stood, keeping the live list in surface order: the
    // rewrite of the head stays ahead of the surviving tail.
    const rewrite = {
      type: 'system/message',
      seq: SessionSeq(3),
      time: 0,
      data: { turn: 1, step: 2, message: systemMessage('rewritten head prompt') },
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
      sourceEventSeqs: [SessionSeq(1)],
    } as unknown as SessionEvent
    state = definition.apply(state, rewrite)
    const systems = (state.systems as readonly { seq: number; tokens: number }[]).map(entry => entry.seq)
    expect(systems).toEqual([3, 2])
    expect(definition.wire.view(state)).toEqual({
      systemTokens: estimateSystemMessage(systemMessage('second prompt, longer')),
      toolsTokens: 0,
      messageTokens: estimateSystemMessage(systemMessage('rewritten head prompt')),
    })
  })

  it('keeps the persisted checkpoint O(1) as the surface grows and compacts', async () => {
    const { ctx, session } = await harness()
    const first = appendUser(session, 'the first of many messages')
    for (let index = 0; index < 24; index += 1) appendUser(session, `message number ${index} with some text`)
    const last = appendUser(session, 'the last message before compaction')
    const stateKeys = (): string[] => {
      const row = ctx.sessionProjections.checkpoint(session)['contextBreakdown']
      if (row === undefined) throw new Error('contextBreakdown checkpoint row is missing')
      return Object.keys(row.val as Record<string, unknown>).sort()
    }
    // Surface growth adds no per-node bookkeeping to the durable state; the
    // systems list is bounded by live system nodes (none here), not the surface.
    expect(stateKeys()).toEqual(['messageTokens', 'systems', 'toolsTokens'])
    const shadowed = session.surface.nodes.slice(
      session.surface.nodes.indexOf(first),
      session.surface.nodes.indexOf(last) + 1,
    )
    appendSummaryMeter(ctx, session, first, last)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
      sourceEventSeqs: [...shadowed],
    })
    expect(stateKeys()).toEqual(['messageTokens', 'systems', 'toolsTokens'])
    expect(projected(ctx, session).messageTokens)
      .toBe(ctx.tokenMeter.measure(session).surfaceTokens)
  })

  it('restores from a JSON checkpoint and unregisters with the token-meter fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    const session = ctx.sessions.create()
    const system = systemMessage('You are terse.')
    session.append('system/message', {
      turn: 1, step: 1, message: system,
    }, { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: CONFIG },
      reason: 'initial',
    })
    appendUser(session, 'abcd')
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('contextBreakdown')

    await ctx.plugin(TokenMeter)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextBreakdown).toEqual({
      systemTokens: estimateSystemMessage(system),
      toolsTokens: 0,
      messageTokens: 9,
    })
  })
})

describe('shared estimator', () => {
  it('prices every content-block shape under the fixed heuristic', () => {
    expect(estimateContent([{ type: 'text', text: 'abcd' }])).toBe(5)
    expect(estimateContent([{ type: 'reasoning', text: 'abcdefgh' }] as ContentBlock[])).toBe(6)
    expect(estimateContent([{ type: 'tool-call', id: 'c' as never, name: 'bash', arguments: '{"a":1}' }])).toBe(7)
    expect(estimateContent([{
      type: 'tool-result', toolCallId: 'c' as never,
      content: [{ type: 'text', text: 'abcd' }],
    }])).toBe(9)
    const unknown = { type: 'mystery', payload: 'abc' } as unknown as ContentBlock
    expect(estimateContent([unknown])).toBe(4 + Math.ceil(JSON.stringify(unknown).length / 4))
  })

  it('prices envelope and system-message parts independently and absent parts to zero', () => {
    const empty = createMessage({
      role: 'system',
      content: [],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(estimateSystemMessage(empty)).toBe(0)
    expect(estimateSystemMessage(systemMessage('abcdefgh'))).toBe(6)
    // A non-text block in a system message prices by its serialized length.
    const structured = createMessage({
      role: 'system',
      content: [{ type: 'tool-call', id: 'c' as never, name: 'bash', arguments: '{}' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(estimateSystemMessage(structured))
      .toBe(Math.ceil(JSON.stringify(structured.content[0]).length / 4) + 4)
    expect(estimateToolsTokens(undefined)).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: [] })).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: TOOLS }))
      .toBe(Math.ceil(JSON.stringify(TOOLS).length / 4) + 4)
  })
})
