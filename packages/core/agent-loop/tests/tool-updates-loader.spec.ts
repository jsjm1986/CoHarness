/**
 * Deferred-tool propagation through a real Loader composition: the deferred
 * flag must survive system-prompt assembly into the logged request header and
 * the provider declaration on a supported route, and be stripped at provider
 * projection — not at assembly — on an unsupported one.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface LoopComposition {
  ctx: Context
  agent: Agent
}

/** Boot the seven loop services through the real Loader over a private root. */
async function composition(): Promise<LoopComposition> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deferred-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: sessions',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: projections',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '- id: systemPrompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '  config:',
    "    personaPrefix: ''",
    "    personaSuffix: ''",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: agents',
    "  name: '@deepseek-ai/dsh-agent'",
    '- id: agentLoop',
    "  name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
  } catch (error) {
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    throw error
  }
  const agent = await ctx.agentLoop.create(SessionId('deferred-loader'), { provider: 'mock', model: 'model' })
  return { ctx, agent }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('deferred tool propagation through a real Loader composition', () => {
  it('keeps the deferred flag through assembly into the logged header and the provider declaration', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    adapter.toolUpdate = 'in-history'
    const { ctx, agent } = await composition()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'deferred_fetch',
      description: 'Deferred fetch test tool.',
      parameters: { query: { type: 'string', required: true } },
      deferLoading: true,
      execute: async () => [{ type: 'text', text: 'done' }],
    }))

    await send(agent, 'first')

    expect(adapter.requests[0]?.tools).toEqual([{
      name: 'deferred_fetch',
      description: 'Deferred fetch test tool.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      deferLoading: true,
    }])
    const headers = agent.session.snapshotEvents().filter(event => event.type === 'request/header')
    expect(headers[0]?.data.header.tools?.[0]).toMatchObject({ name: 'deferred_fetch', deferLoading: true })
    // Reconstructing the header from a copied event log agrees with the live fold.
    const replayed = Session.create(agent.id, agent.session.snapshotEvents()).requestHeader()
    expect(replayed?.tools?.[0]).toMatchObject({ name: 'deferred_fetch', deferLoading: true })
  })

  it('strips the deferred flag at provider projection on an unsupported route, not at assembly', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx, agent } = await composition()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'deferred_fetch',
      description: 'Deferred fetch test tool.',
      parameters: { query: { type: 'string', required: true } },
      deferLoading: true,
      execute: async () => [{ type: 'text', text: 'done' }],
    }))

    await send(agent, 'first')

    expect((await ctx.systemPrompt.assemble()).tools[0]?.deferLoading).toBe(true)
    expect(adapter.requests[0]?.tools?.[0]).toMatchObject({ name: 'deferred_fetch' })
    expect(adapter.requests[0]?.tools?.[0]).not.toHaveProperty('deferLoading')
  })
})
