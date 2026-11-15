import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

const SIGNAL = new AbortController().signal
const TEAM_TOOLS = ['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']

const roots: string[] = []
const contexts: Context[] = []
let calls = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-tools-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  await ctx.plugin(toolTeam)
  const adapter = new MockAdapter([textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead }
}

async function call(ctx: Context, name: string, args: unknown, agent: Agent) {
  const toolSet = await ctx.tools.resolve({ agent, signal: SIGNAL })
  try {
    return await executeModelToolFixture(ctx, {
      callId: ToolCallId(`call-${++calls}`),
      name,
      arguments: args,
      signal: SIGNAL,
      agent,
      toolSet,
    })
  } finally {
    toolSet.dispose()
  }
}

async function admitted(ctx: Context, agent: Agent): Promise<string[]> {
  const toolSet = await ctx.tools.resolve({ agent, signal: SIGNAL })
  try {
    return [...toolSet.view(agent).keys()].sort()
  } finally {
    toolSet.dispose()
  }
}

describe('Agent Teams task tools', () => {
  it('admits task tools only while Team mode is on', async () => {
    const { ctx, lead } = await setup()
    expect(await admitted(ctx, lead)).not.toContain('team_task_list')
    await ctx.agentTeams.setEnabled(lead, true)
    const after = await admitted(ctx, lead)
    for (const name of TEAM_TOOLS) expect(after).toContain(name)
  })

  it('registers exactly the four current task tools', async () => {
    const { ctx, lead } = await setup()
    const registered = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(registered.filter(name => name.startsWith('team_'))).toEqual(TEAM_TOOLS)
    for (const retired of ['spawn_teammate', 'followup_task', 'wait_agent', 'interrupt_agent']) {
      expect(registered).not.toContain(retired)
    }
    void lead
  })

  it('creates, lists, gets, and updates tasks through model-facing tools', async () => {
    const { ctx, lead } = await setup()
    await ctx.agentTeams.setEnabled(lead, true)
    const created = await call(ctx, 'team_task_create', {
      subject: 'work', description: 'do the work', write_scopes: ['src'],
    }, lead)
    expect(created.error).toBeUndefined()
    const first = created.content.at(0)
    const task = JSON.parse(first?.type === 'text' ? first.text : '{}') as { id: string; revision: number }
    expect(task.id).toBe('task-1')
    const listed = await call(ctx, 'team_task_list', {}, lead)
    const listedFirst = listed.content.at(0)
    expect(listedFirst?.type === 'text' && listedFirst.text).toContain('"subject":"work"')
    const fetched = await call(ctx, 'team_task_get', { task_id: 'task-1' }, lead)
    const fetchedFirst = fetched.content.at(0)
    expect(fetchedFirst?.type === 'text' && fetchedFirst.text).toContain('"revision":1')
    const updated = await call(ctx, 'team_task_update', {
      task_id: 'task-1', expected_revision: 1, action: 'claim',
    }, lead)
    const updatedFirst = updated.content.at(0)
    expect(updatedFirst?.type === 'text' && updatedFirst.text).toContain('"owner":"lead"')
    void task
  })
})
