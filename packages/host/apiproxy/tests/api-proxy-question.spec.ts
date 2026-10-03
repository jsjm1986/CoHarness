import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ExecutionInheritance, ExecutionInputId, ExecutionScopeId } from '@deepseek-ai/dsh-execution-authority'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return {
    ctx,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
  }
}

async function agent(ctx: Context): Promise<Agent> {
  const session = ctx.sessions.create()
  const value = { id: session.id, session, status: 'idle', ctx, inbox: { nextStep: [], nextTurn: [] } } as unknown as Agent
  await ctx.agents.register(value)
  return value
}

function openMux(api: ApiProxy, abort: AbortController): {
  envelopes: RpcRequest<MuxFrame>[]
  waitForQuestion(): Promise<RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>>
} {
  const envelopes: RpcRequest<MuxFrame>[] = []
  let resolveQuestion!: (value: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>) => void
  const question = new Promise<RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>>((resolve) => {
    resolveQuestion = resolve
  })
  void (async () => {
    for await (const envelope of api.events.mux({ rpcId: RpcId('question-mux'), payload: {} }, abort.signal)) {
      envelopes.push(envelope)
      if (envelope.payload.type === 'question/requested') {
        resolveQuestion(envelope as RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>)
      }
    }
  })()
  return { envelopes, waitForQuestion: () => question }
}

function answer(
  envelope: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>,
  selected: string[],
  custom?: string,
): Parameters<ApiProxy['respond']>[0] {
  return {
    type: 'client-response',
    rpcId: envelope.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: envelope.payload.sessionId,
        answer: {
          answers: [{
            id: envelope.payload.questions[0]?.id,
            selected,
            ...custom === undefined ? {} : { custom },
          }],
        },
      },
    },
  }
}

describe('question response validation', () => {
  it('answers under the execution captured when the question opened after a newer request becomes current', async () => {
    const { ctx, api } = await harness()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const target = await agent(ctx)
    const original: ExecutionInheritance = { parentSessionId: target.id,
      scopeId: '10000000-0000-4000-8000-000000000001' as ExecutionScopeId,
      inputs: ['10000000-0000-4000-8000-000000000002' as ExecutionInputId], primaryActorUserId: 1, unverifiedHistory: false }
    let current = original
    const capture = vi.fn(() => current), claim = vi.fn(async () => true)
    ctx.provide('executionAuthority', { capture, answer: claim } as never)
    const abort = new AbortController()
    onTestFinished(() => { abort.abort() })
    const mux = openMux(api, abort)
    const asked = ctx.userQuestions.ask({ agent: target, questions: [{ id: 'decision', question: 'Continue?', options: [{ label: 'Yes' }] }] })
    const envelope = await mux.waitForQuestion()
    current = { ...original, scopeId: '20000000-0000-4000-8000-000000000001' as ExecutionScopeId, primaryActorUserId: 2 }
    expect(await api.respond(answer(envelope, ['Yes']))).toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'decision', selected: ['Yes'] }] })
    expect(capture).toHaveBeenCalledOnce()
    expect(claim).toHaveBeenCalledWith(target.session, envelope.rpcId, { answers: [{ id: 'decision', selected: ['Yes'] }] }, original)
    abort.abort()
  })

  it('accepts selected options with custom text for multi-select questions', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const mux = openMux(api, abort)
    const asked = ctx.userQuestions.ask({
      agent: await agent(ctx),
      questions: [{
        id: 'targets',
        question: 'Choose targets and add another',
        multiSelect: true,
        options: [{ label: 'Code' }, { label: 'Docs' }],
      }],
    })
    const envelope = await mux.waitForQuestion()

    expect(await api.respond(answer(envelope, ['Code', 'Docs'], 'Release notes')))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'targets', selected: ['Code', 'Docs'], custom: 'Release notes' }],
    })
    expect(mux.envelopes.some(item => item.payload.type === 'question/resolved')).toBe(true)
    abort.abort()
  })

  it('keeps selected options and custom text mutually exclusive for single-select questions', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const mux = openMux(api, abort)
    const asked = ctx.userQuestions.ask({
      agent: await agent(ctx),
      questions: [{
        id: 'target',
        question: 'Choose one target',
        options: [{ label: 'Code' }, { label: 'Docs' }],
      }],
    })
    const envelope = await mux.waitForQuestion()

    expect(await api.respond(answer(envelope, ['Code'], 'Release notes')))
      .toEqual({ accepted: false, reason: 'bad-response' })
    expect(await api.respond(answer(envelope, [], 'Release notes')))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'target', selected: [], custom: 'Release notes' }],
    })
    abort.abort()
  })
})
