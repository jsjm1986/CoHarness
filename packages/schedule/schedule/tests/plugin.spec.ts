import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { LegacySessionHandle, SessionHandle, SessionPersistenceCreateOptions } from '@deepseek-ai/dsh-session-persistence'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import * as toolSchedule from '../src/index.ts'
import { createAfterScheduleRecord, foldScheduleEvents, ScheduleId } from '../src/domain.ts'

class PersistenceProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /** Minimal handle surface for AgentLoop lifecycle tests without a backend. */
  async createHandle(id: SessionId): Promise<LegacySessionHandle> {
    return {
      id,
      mode: 'write',
      read: async () => [],
      append: async () => {},
      flush: async () => {},
      close: async () => {},
    }
  }

  /** Minimal create surface for AgentLoop publication; nothing durable is kept. */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    const handle: SessionHandle = {
      id: header.id,
      header,
      inheritedEventCount: options?.inheritedEventCount ?? SessionLogOffset(0),
      access: 'write',
      read: async () => ({ eventState: 'detached', events: [] }),
      append: async () => {},
      flush: async () => {},
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }
    return handle
  }
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('Schedule plugin composition', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in toolSchedule).toBe(false)
    expect(toolSchedule.name).toBe('schedule')
    expect(toolSchedule.inject).toEqual(['agents', 'sessions', 'tools', 'sessionPersistence'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolSchedule)).toBe(toolSchedule)
  })

  it('installs only on future root agents and unwinds on plugin disposal', async () => {
    const ctx = await harness()
    const existing = await ctx.agents.create({ sessionId: SessionId('schedule-existing') })
    const plugin = await ctx.plugin(toolSchedule)
    expect(ctx.tools.get('schedule_create', existing.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    const root = await ctx.agents.create({ sessionId: SessionId('schedule-root') })
    expect(ctx.tools.get('schedule_create', root.agent)?.name).toBe('schedule_create')
    expect(ctx.tools.get('schedule_list', root.agent)?.name).toBe('schedule_list')
    expect(ctx.tools.get('schedule_delete', root.agent)?.name).toBe('schedule_delete')
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    const created = await ctx.agents.withInitiator(root.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('schedule-plugin-create'),
      name: 'schedule_create',
      arguments: { prompt: 'future reminder', after_seconds: 3_600 },
      agent: root.agent,
    }))
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('expected Schedule create value')
    expect(created.value).toMatchObject({ id: 'schedule-1', deliveryMode: 'session-local' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'running' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })

    const child = await root.agent.ctx.agents.create({
      sessionId: SessionId('schedule-child'),
      parentAgent: root.agent,
    })
    expect(ctx.agents.roots()).toEqual([existing.agent, root.agent])
    expect(ctx.tools.get('schedule_create', child.agent)).toBeUndefined()

    const departing = await ctx.agents.create({ sessionId: SessionId('schedule-departing') })
    expect(ctx.tools.get('schedule_create', departing.agent)).toBeDefined()
    await departing.dispose()
    expect(ctx.tools.get('schedule_create', departing.agent)).toBeUndefined()

    await plugin.dispose()
    expect(ctx.tools.get('schedule_create', root.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_list', root.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_delete', root.agent)).toBeUndefined()

    await child.dispose()
    await root.dispose()
    await existing.dispose()
    await ctx.fiber.dispose()
  })

  it('does not checkpoint unrelated idle sessions', async () => {
    const ctx = await harness()
    const plugin = await ctx.plugin(toolSchedule)
    const root = await ctx.agents.create({ sessionId: SessionId('schedule-unrelated-idle') })
    await settle()
    let flushes = 0
    const stopFlush = ctx.on('session/flush', (session) => {
      if (session === root.agent.session) flushes += 1
    })

    agentEvents(ctx, root.agent).emit('agent/status', { status: 'running' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })
    await settle()
    expect(flushes).toBe(0)

    stopFlush()
    await root.dispose()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })
})

describe('Schedule archive admission', () => {
  const ask = (ctx: Context, sessionId: SessionId, next?: () => Promise<readonly SessionActivity[]>) =>
    ctx.waterfall('workspace/session-activity', { sessionId }, next ?? (() => Promise.resolve([])))

  it('reports a live root Session its armed reminders and deletes them on a stop request', async () => {
    const ctx = await harness()
    const plugin = await ctx.plugin(toolSchedule)
    const root = await ctx.agents.create({ sessionId: SessionId('schedule-archive-admission') })
    const sessionId = root.agent.session.id
    const listeners = (event: 'workspace/session-activity' | 'workspace/session-stop') =>
      ctx.events._hooks[event]?.length ?? 0

    // A Session without armed reminders reports nothing of its own and still delegates.
    expect(await ask(ctx, sessionId)).toEqual([])
    const delegated = async () => [{ kind: 'turn' } as const]
    expect(await ask(ctx, sessionId, delegated)).toEqual([{ kind: 'turn' }])

    const record = createAfterScheduleRecord(ScheduleId('schedule-1'), 'check the build', 3_600, Date.now())
    root.agent.session.append('schedule/change', { version: 1, operation: 'create', schedule: record })

    // The armed reminder is the reason to refuse the archive, and it names what must stop.
    expect(await ask(ctx, sessionId)).toEqual([
      { kind: 'schedule', items: [{ id: 'schedule-1', label: 'check the build' }] },
    ])
    // Another provider's family keeps its own entries.
    expect(await ask(ctx, sessionId, delegated)).toEqual([
      { kind: 'schedule', items: [{ id: 'schedule-1', label: 'check the build' }] },
      { kind: 'turn' },
    ])
    // A Session with no live root Agent has nothing armed and reports nothing.
    expect(await ask(ctx, SessionId('schedule-archive-cold'))).toEqual([])

    // A stop request durably deletes the armed reminders, so a second one has nothing left to stop.
    await ctx.parallel('workspace/session-stop', { sessionId })
    expect(foldScheduleEvents(root.agent.session.ownEvents()).active).toEqual([])
    expect(await ask(ctx, sessionId)).toEqual([])
    await ctx.parallel('workspace/session-stop', { sessionId })

    // Disposal withdraws both listeners with the plugin.
    const armedActivity = listeners('workspace/session-activity')
    const armedStop = listeners('workspace/session-stop')
    await plugin.dispose()
    expect(listeners('workspace/session-activity')).toBe(armedActivity - 1)
    expect(listeners('workspace/session-stop')).toBe(armedStop - 1)
    expect(await ask(ctx, sessionId, delegated)).toEqual([{ kind: 'turn' }])

    await root.dispose()
    await ctx.fiber.dispose()
  })

  it('orders a stop behind a management write still holding the owner queue', async () => {
    const ctx = await harness()
    await ctx.plugin(toolSchedule)
    const root = await ctx.agents.create({ sessionId: SessionId('schedule-stop-race') })
    const sessionId = root.agent.session.id
    // The runtime's initial drive finishes before the barrier gate arms.
    await settle()

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let armed = false
    const gate = ctx.on('session/flush', (session) => {
      if (session !== root.agent.session || !armed) return
      entered.resolve(undefined)
      return release.promise
    })

    armed = true
    const creating = ctx.agents.withInitiator(root.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('schedule-stop-race-create'),
      name: 'schedule_create',
      arguments: { prompt: 'check the build', after_seconds: 3_600 },
      agent: root.agent,
    }))
    // The create now holds the exact owner's Schedule queue inside its checkpoint.
    await entered.promise
    const stopping = ctx.parallel('workspace/session-stop', { sessionId })
    let settled = false
    void stopping.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 25))
    // A stop that read the fold outside the queue has already returned, unable to see the committing create.
    expect(settled).toBe(false)
    release.resolve(undefined)
    await creating
    await stopping
    // The stop joined the same queue, so it saw the committed create and deleted it.
    expect(await ask(ctx, sessionId)).toEqual([])

    gate()
    await root.dispose()
    await ctx.fiber.dispose()
  })

  it('stops only the asked Session, not a sibling live owner', async () => {
    const ctx = await harness()
    await ctx.plugin(toolSchedule)
    const first = await ctx.agents.create({ sessionId: SessionId('schedule-stop-first') })
    const second = await ctx.agents.create({ sessionId: SessionId('schedule-stop-second') })

    first.agent.session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: createAfterScheduleRecord(ScheduleId('schedule-1'), 'first reminder', 3_600, Date.now()),
    })
    second.agent.session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: createAfterScheduleRecord(ScheduleId('schedule-1'), 'second reminder', 3_600, Date.now()),
    })

    await ctx.parallel('workspace/session-stop', { sessionId: first.agent.session.id })
    expect(foldScheduleEvents(first.agent.session.ownEvents()).active).toEqual([])
    expect(foldScheduleEvents(second.agent.session.ownEvents()).active).toHaveLength(1)
    expect(await ask(ctx, second.agent.session.id)).toEqual([
      { kind: 'schedule', items: [{ id: 'schedule-1', label: 'second reminder' }] },
    ])

    await first.dispose()
    await second.dispose()
    await ctx.fiber.dispose()
  })
})
