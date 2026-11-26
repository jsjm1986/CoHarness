/** Root-fiber shutdown drains buffered session events durably (both mount orders). */

import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { inboxProjectionDefinition } from '../src/inbox.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function mount(order: 'backend-first' | 'loop-first'): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-drain-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  if (order === 'backend-first') {
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
  } else {
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root })
  }
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  return { ctx, root }
}

const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function holdTurn(ctx: Context, id: SessionId) {
  const { agent } = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  agent.ctx.on('agent/request', async ({ signal }, next) => {
    signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    signal.throwIfAborted()
    return next()
  })
  agent.followup(input('active'))
  await entered.promise
  return { agent, aborted, release }
}

describe.each(['backend-first', 'loop-first'] as const)('root shutdown drain (%s)', (order) => {
  it('persists buffered turn events without an explicit flush before dispose', async () => {
    const { ctx, root } = await mount(order)
    const sessionId = SessionId('shutdown-drain')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    // No explicit flush and no agent dispose: root teardown must drain.
    await ctx.fiber.dispose()

    const verify = new Context()
    await verify.plugin(JsonlSessionPersistence, { root })
    const reader = await verify.sessionPersistence.open(sessionId, 'read')
    const { events } = await reader.read()
    await reader.close()
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await verify.fiber.dispose()
  })

  it('awaits producers and a durable checkpoint while preserving admitted inbox work', async () => {
    const { ctx, root } = await mount(order)
    const id = SessionId('planned-shutdown-drain')
    const { agent, aborted, release } = await holdTurn(ctx, id)
    const step = input('admitted steering')
    const turn = input('admitted follow-up')
    const pendingNotice = createUserMessage({ content: [{ type: 'text', text: 'scope notice' }], source: { kind: 'fixture' } })
    const checkpoint = Promise.withResolvers<undefined>()
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    let completed = false
    try {
      agent.send(step, 'next-step', false)
      agent.send(turn, 'next-turn', false)
      agent.send(pendingNotice, 'next-step', false)
      agent.ctx.effect(() => () => {
        agent.cancel({ kind: 'parent' })
        agent.inbox.remove(pendingNotice.id)
      })
      ctx.on('session/flush', async (session) => {
        if (session !== agent.session) return
        checkpoint.resolve(undefined)
        await releaseCheckpoint.promise
      })
      const stopped = ctx.agentLoop.stopForShutdown()
      void stopped.then(() => { completed = true }, () => {})
      await aborted.promise
      expect(completed).toBe(false)
      expect(() =>{  agent.followup(input('late input')) }).toThrow('input is closed')
      expect(() => agent.inbox.remove(step.id)).toThrow('input is closed')
      expect(() => agent.runMaintenance(async () => undefined)).toThrow('input is closed')
      await expect(ctx.agents.create({ sessionId: SessionId('late') })).rejects.toThrow('agent loop is not active')
      release.resolve(undefined)
      await checkpoint.promise
      expect(completed).toBe(false)
      expect(() => agent.session.append('step/end', { turn: 1, step: 1 })).toThrow('sealed for shutdown')
      releaseCheckpoint.resolve(undefined)
      await stopped
      expect(ctx.agents.list()).toEqual([])
    } finally {
      release.resolve(undefined)
      releaseCheckpoint.resolve(undefined)
      await ctx.fiber.dispose()
    }

    const verify = new Context()
    try {
      await verify.plugin(JsonlSessionPersistence, { root })
      await using reader = await verify.sessionPersistence.open(id, 'read')
      const { events } = await reader.read()
      expect(events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
      expect(events.at(-1)).toMatchObject({ type: 'agent/inbox/spliced', data: { outcome: 'canceled', inserted: [], removedCount: 1 } })
      expect(events.reduce((state, event) => inboxProjectionDefinition.apply(state, event), inboxProjectionDefinition.init())).toEqual({
        'next-step': [step], 'next-turn': [turn],
      })
    } finally { await verify.fiber.dispose() }
  })

  it('rejects planned shutdown when JSONL cannot write the final turn boundary', async () => {
    const { ctx } = await mount(order)
    const { agent, aborted, release } = await holdTurn(ctx, SessionId('planned-shutdown-write-failed'))
    try {
      await ctx.sessions.flush(agent.session)
      const file = ctx.sessionPersistence.locate(agent.session.header)?.path
      if (file === undefined) throw new Error('test did not resolve the live JSONL artifact')
      await rename(file, `${file}.saved`)
      await mkdir(file)
      const stopped = ctx.agentLoop.stopForShutdown()
      void stopped.catch(() => {})
      await aborted.promise
      release.resolve(undefined)
      await expect(stopped).rejects.toThrow()
      expect(agent.session.snapshotEvents().at(-1)?.type).toBe('turn/end')
      expect(ctx.agents.list()).toEqual([])
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })
})
