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
import TeamService from '../src/index.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-persist-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  const adapter = new MockAdapter([textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, storageRoot }
}

describe('Team persistence confirmation', () => {
  it('confirms version-2 task records in the durable root Session log', async () => {
    const { ctx, lead, storageRoot } = await setup()
    await ctx.agentTeams.setEnabled(lead, true)
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'durable', description: 'written through',
    }, SIGNAL)
    const rows = lead.session.snapshotEvents()
    const record = rows.find(row => row.type === 'team/task')
    expect(record?.data).toMatchObject({
      version: 2,
      task: { id: task.id, revision: 1, status: 'pending' },
    })
    expect(rows.some(row => row.type === 'team/mode'
      &&  row.data.enabled)).toBe(true)
    expect(storageRoot).toContain('dsh-team-persist-')
  })
})
