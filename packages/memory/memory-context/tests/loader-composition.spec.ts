// REAL Loader composition: a cordis.yml boots storage-json, storage-domain,
// memory, memory-context, and tool-memory through the real plugin Loader.
// Session 1 saves through the executor; a fresh context over the same storage
// root publishes the durable entry in its saved-memory catalog.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as MemoryContext from '../src/index.ts'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the memory stack's cordis.yml through the real Loader over `storageRoot`. */
async function boot(storageRoot: string): Promise<Context> {
  const configPath = join(root!, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    `  config: { root: ${JSON.stringify(storageRoot)} }`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config: { backend: json }',
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-memory'",
    "- name: '@deepseek-ai/dsh-memory-context'",
    "- name: '@deepseek-ai/dsh-tool-memory'",
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-memory', MemoryService],
    ['@deepseek-ai/dsh-memory-context', MemoryContext],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
  ])
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('the Node loader internals are required to stub module resolution')
  ctx.loader.internal = {
    ...internal,
    async import(specifier: string) {
      const mod = modules.get(specifier)
      if (mod === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return mod
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** A minimal Agent whose session carries a workspace cwd. */
async function agent(ctx: Context, id: string, cwd: string): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const value: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

describe('memory loader composition', () => {
  it('saves in session 1 and publishes the saved-memory catalog in session 2 over durable JSON storage', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
    const storageRoot = join(root, 'storage')
    const signal = new AbortController().signal

    const ctx1 = await boot(storageRoot)
    const agent1 = await agent(ctx1, 'session-1', '/repo')
    const saved = await ctx1.tools.execute({
      signal,
      callId: ToolCallId('call-1'),
      name: 'memory_save',
      arguments: { scope: 'personal', key: 'release-freeze', kind: 'background', summary: 'freeze window', content: 'No deploys Friday.' },
      agent: agent1,
    })
    expect(saved.isError).toBe(false)
    await ctx1.fiber.dispose()

    // The durable record landed in the JSON per-record layout.
    const unit = await readdir(storageRoot)
    expect(unit.some(name => name.startsWith('memory'))).toBe(true)

    const ctx2 = await boot(storageRoot)
    const agent2 = await agent(ctx2, 'session-2', '/repo')
    const decision = await agentEvents(ctx2, agent2).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const catalog = decision.messages.find(message => message.source.kind === 'memory-catalog')
    expect(catalog).toBeDefined()
    const text = catalog!.content[0]?.type === 'text' ? catalog!.content[0].text : ''
    expect(text).toContain('- `release-freeze` [background,')
    expect((catalog!.source as { entries?: { name: string }[] }).entries?.[0]?.name).toBe('release-freeze')
  })
})
