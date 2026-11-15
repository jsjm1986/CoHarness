import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamError, TeamId, TeamTaskId } from '../src/index.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('done')],
  config: ConstructorParameters<typeof TeamService>[1] = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, adapter, storageRoot }
}

describe('TeamService', () => {
  it('gates task mutations behind the root Team selection', async () => {
    const { ctx, lead } = await setup()
    expect(ctx.agentTeams.isEnabled(lead)).toBe(false)
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'work', description: 'do work',
    }, SIGNAL)).rejects.toMatchObject({ code: 'TEAM_DISABLED' })
    await ctx.agentTeams.setEnabled(lead, true)
    expect(ctx.agentTeams.isEnabled(lead)).toBe(true)
    const created = await ctx.agentTeams.createTask(lead, {
      subject: 'work', description: 'do work',
    }, SIGNAL)
    expect(created.id).toBe(TeamTaskId('task-1'))
  })

  it('persists team/mode and defaults to enabled on historical task logs', async () => {
    const { ctx, lead, storageRoot } = await setup()
    await ctx.agentTeams.setEnabled(lead, true)
    const events = lead.session.snapshotEvents().filter(row => row.type === 'team/mode')
    expect(events).toHaveLength(1)
    expect((events[0]?.data as { enabled: boolean }).enabled).toBe(true)
    // A second selection of the same mode flushes without duplicating the event.
    await ctx.agentTeams.setEnabled(lead, true)
    expect(lead.session.snapshotEvents().filter(row => row.type === 'team/mode')).toHaveLength(1)
    void storageRoot
  })

  it('runs create/read/update with expected-revision compare-and-set', async () => {
    const { ctx, lead } = await setup()
    await ctx.agentTeams.setEnabled(lead, true)
    const created = await ctx.agentTeams.createTask(lead, {
      subject: 'A', description: 'first', writeScopes: ['src'],
    }, SIGNAL)
    expect(created).toMatchObject({ revision: 1, status: 'pending', ready: true })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: 1, action: 'claim',
    }, SIGNAL)
    expect(claimed).toMatchObject({ status: 'in_progress', ownerId: lead.id })
    // The redundant name is omitted when it equals the Session id.
    expect(claimed.ownerName).toBeUndefined()
    // Stale revisions lose the race against the committed task.
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: 1, action: 'complete',
    }, SIGNAL)).rejects.toBeInstanceOf(TeamError)
    const completed = await ctx.agentTeams.updateTask(lead, {
      taskId: claimed.id, expectedRevision: 2, action: 'complete',
    }, SIGNAL)
    expect(completed.status).toBe('completed')
    expect(ctx.agentTeams.getTask(lead, claimed.id).status).toBe('completed')
    expect(ctx.agentTeams.listTasks(lead)).toHaveLength(1)
  })

  it('scopes the task board to each root Session log', async () => {
    const { ctx, lead } = await setup()
    const other = await ctx.agentLoop.create(SessionId('other'), { provider: 'mock', model: 'mock' })
    await ctx.agentTeams.setEnabled(lead, true)
    await ctx.agentTeams.setEnabled(other, true)
    await ctx.agentTeams.createTask(lead, { subject: 'A', description: 'lead task' }, SIGNAL)
    expect(ctx.agentTeams.listTasks(lead)).toHaveLength(1)
    expect(ctx.agentTeams.listTasks(other)).toHaveLength(0)
  })

  it('reads historical version 1 task records without rewriting them', async () => {
    const { ctx, lead } = await setup()
    lead.session.append('team/task', {
      version: 1,
      teamId: TeamId(lead.id),
      task: {
        id: TeamTaskId('task-1'), revision: 1, subject: 'legacy',
        description: 'durable', status: 'pending', blockedBy: [], writeScopes: [],
      },
    })
    await ctx.sessions.flush(lead.session)
    // Historical task records imply enabled mode so existing v1 logs stay actionable.
    expect(ctx.agentTeams.isEnabled(lead)).toBe(true)
    const legacy = ctx.agentTeams.getTask(lead, TeamTaskId('task-1'))
    expect(legacy.subject).toBe('legacy')
    const rows = lead.session.snapshotEvents().filter(row => row.type === 'team/task')
    expect((rows[0]?.data as { version: number }).version).toBe(1)
  })

  it('rejects removed configuration keys at load', async () => {
    await expect(setup([], { maxMembers: 8 } as never)).rejects.toMatchObject({
      code: 'TEAM_INVALID_CONFIG',
    })
  })
})
