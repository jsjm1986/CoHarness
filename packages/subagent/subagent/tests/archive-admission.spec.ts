import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { provideWorkingDirectoryFixture, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

/** Register live children without a model turn; cancellation is the behavior under test. */
async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  provideWorkingDirectoryFixture(ctx)
  const runtime = await ctx.plugin(SubagentRuntime)
  const add = async (id: string, meta: Pick<SessionHeader, 'parentSession' | 'origin'>, cancel: Agent['cancel'], status: Agent['status'] = 'running') => {
    const scope = await ctx.plugin(() => {})
    const session = ctx.sessions.create(SessionId(id), { meta })
    const agent: Agent = {
      id: session.id, session, options: {}, ctx: scope.ctx, status, inbox: unsupportedInbox(),
      send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel,
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    return agent
  }
  return { ctx, add, runtime }
}

it.each<{ kind: string; failure: unknown }>([
  { kind: 'ordinary', failure: new Error('child refuses cancel') },
  { kind: 'unrenderable', failure: Object.create(null) },
])('cancels remaining descendants when one child throws an $kind error', async ({ failure }) => {
  const { ctx, add } = await harness()
  const parent = SessionId('archive-parent')
  const first = await add('archive-child', { parentSession: parent, origin: 'subagent' }, () => { throw failure })
  const cancel = vi.fn()
  await add('archive-grandchild', { parentSession: first.id, origin: 'subagent' }, cancel)
  const foreign = vi.fn()
  await add('foreign-child', { parentSession: SessionId('another-parent'), origin: 'subagent' }, foreign)
  await add('independent-fork', { parentSession: parent }, foreign)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

  await ctx.parallel('workspace/session-stop', { sessionId: parent })

  expect(cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' })
  expect(foreign).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`cancelling "${first.id}"`))
})

it('reports running descendants through an idle parent, terminates cyclic lineage and releases its listeners on unload', async () => {
  const { ctx, add, runtime } = await harness()
  const parent = SessionId('archive-cycle-root')
  const first = await add('archive-cycle-child', { parentSession: parent, origin: 'subagent' }, () => {}, 'idle')
  await add(parent, { parentSession: first.id, origin: 'subagent' }, () => {}, 'idle')
  const cancel = vi.fn()
  const grandchild = await add('archive-cycle-grandchild', { parentSession: first.id, origin: 'subagent' }, cancel)
  ctx.on('workspace/session-activity', async (_request, next) => [...await next(), { kind: 'turn' }])
  const activity = () => ctx.waterfall('workspace/session-activity', { sessionId: parent }, () => Promise.resolve([]))

  expect(await activity()).toEqual([{ kind: 'subagent', items: [{ id: grandchild.id }] }, { kind: 'turn' }])
  expect(await ctx.waterfall('workspace/session-activity', { sessionId: SessionId('quiet') }, () => Promise.resolve([])))
    .toEqual([{ kind: 'turn' }])
  await runtime.dispose()
  expect(await activity()).toEqual([{ kind: 'turn' }])
  await ctx.parallel('workspace/session-stop', { sessionId: parent })
  expect(cancel).not.toHaveBeenCalled()
})

it('uses owned descriptor labels and keeps unreadable or absent descriptors identifiable', async () => {
  const { ctx, add } = await harness()
  const parent = SessionId('archive-label-parent')
  const labeled = await add('archive-labeled', { parentSession: parent, origin: 'subagent' }, () => {})
  labeled.session.append('subagent/descriptor', {
    version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'fixture', label: 'archive worker',
  })
  const unlabeled = await add('archive-unlabeled', { parentSession: parent, origin: 'subagent' }, () => {})
  const unreadable = await add('archive-unreadable', { parentSession: parent, origin: 'subagent' }, () => {})
  await ctx.plugin(TestSessionQuery)
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) => {
    if (id === unreadable.id) throw new Error('damaged child observation')
    return observe(id, options)
  })

  expect(await ctx.waterfall('workspace/session-activity', { sessionId: parent }, () => Promise.resolve([])))
    .toEqual([{ kind: 'subagent', items: [{ id: labeled.id, label: 'archive worker' }, { id: unlabeled.id }, { id: unreadable.id }] }])
})
