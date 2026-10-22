/** A real Loader-composed loop drains a capacity refusal and resumes from the durable prefix. */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scheduler } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

it('parks a refused turn, rejects false durability, releases its writer, and completes after repair and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-retention-loader-'))
  const ctx = new Context()
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm', "  name: '@deepseek-ai/dsh-llm'",
      '- id: sessions', "  name: '@deepseek-ai/dsh-session'",
      '- id: projections', "  name: '@deepseek-ai/dsh-session-projection'",
      '- id: system', "  name: '@deepseek-ai/dsh-system-prompt'",
      '  config:', "    personaPrefix: ''", "    personaSuffix: ''",
      '- id: tools', "  name: '@deepseek-ai/dsh-tools'",
      '- id: agents', "  name: '@deepseek-ai/dsh-agent'",
      '- id: persistence', "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`,
      '    compression: none', '    maxPendingBytes: 20000',
      '- id: loop', "  name: '@deepseek-ai/dsh-agent-loop'", '  config:', '    agents: []', '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPlugin],
    ])
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected plugin: ${specifier}`)
        return modules.get(specifier)
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const adapter = new MockAdapter([textResponse('x'.repeat(30_000)), textResponse('recovered')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const sessionId = SessionId('capacity-loop')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'model' } })
    const { agent } = handle
    const statuses: string[] = []
    ctx.on('agent/status', ({ status }) => { statuses.push(status) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const accepted = agent.session.snapshotEvents()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.status).toBe('idle')
    expect(accepted.some(event => event.type === 'step/start')).toBe(true)
    expect(accepted.some(event => event.type === 'assistant/message' || event.type === 'step/end' || event.type === 'turn/end')).toBe(false)
    expect(() => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'refused' }], source: { kind: 'user' } }))
    }).toThrow(/new event refused/u)
    await expect(ctx.sessions.flush(agent.session)).rejects.toThrow(/new event refused/u)
    await scheduler.yield()
    expect(statuses).toEqual(['running', 'idle'])
    expect(adapter.requests).toHaveLength(1)
    await expect(handle.dispose()).rejects.toThrow(/new event refused/u)
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()

    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'model' } })
    const repairs = resumed.agent.session.snapshotEvents().slice(accepted.length)
    expect(repairs.some(event => event.type === 'step/end')).toBe(true)
    expect(repairs.some(event => event.type === 'turn/end')).toBe(true)
    resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    await ctx.sessions.flush(resumed.agent.session)
    expect(adapter.requests).toHaveLength(2)
    expect(resumed.agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'recovered' }])
    await resumed.dispose()
    const reopened = await ctx.sessionPersistence.open(sessionId, 'write')
    await reopened.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
