/** Real MCP subprocesses must wait for the host's node accountant. */
import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import * as McpClient from '../src/index.ts'
import { createScope } from '@deepseek-ai/dsh-scope'
import { McpProcessOwner } from '../src/managed-stdio.ts'

type ResourceRequest = Parameters<Context['resourceBudget']['acquire']>[0]
type ResourceLease = Awaited<ReturnType<Context['resourceBudget']['acquire']>>

it('refuses MCP probe and serving processes when node admission is denied', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const acquire = vi.fn(async () => { throw new Error('MCP process admission denied') })
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { acquire = acquire }(ctx)
  const connection = startConnection(ctx, {
    transport: 'stdio', serverName: 'admission-fixture',
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./fixture-server.ts', import.meta.url))],
    env: {}, cwd: process.cwd(), toolCallTimeoutMs: 5_000, failOnStartupError: true,
  }, resolveReconnectPolicy({ enabled: false }, 'admission fixture'))
  onTestFinished(async () => { await connection.dispose() })
  expect((await connection.ready).error).toBeInstanceOf(Error)
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process', origin: 'infrastructure' }))
}, 20_000)

it('captures the nearest exact Agent scope before private allocation instead of an ambient initiator', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const parent = { id: 'mcp-parent' as NonNullable<ResourceRequest['sessionId']> }
  const child = { id: 'mcp-child' as NonNullable<ResourceRequest['sessionId']> }
  ctx.provide('agents', {
    list: () => [parent, child], currentInitiator: () => parent,
  } as Context['agents'])
  const agentScope = createScope(ctx, child, { parent })
  const nested = createScope(agentScope.ctx, {}, { parent: child })
  const acquire = vi.fn(async (_request: ResourceRequest) => { throw new Error('captured MCP allocation refused') })
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { acquire = acquire }(ctx)
  const owner = new McpProcessOwner(nested.ctx, {
    transport: 'stdio', serverName: 'scoped', command: 'unused', args: [], env: {}, cwd: '',
    toolCallTimeoutMs: 5_000, failOnStartupError: true,
  })
  onTestFinished(async () => { await owner.close() })
  await expect(owner.transport().start()).rejects.toThrow('captured MCP allocation refused')
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process', sessionId: child.id }))
})

it('returns a late cancelled startup grant before any MCP probe can allocate', async () => {
  const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'dsh-mcp-queued-'))
  const grant = Promise.withResolvers<ResourceLease>(), requested = Promise.withResolvers<ResourceRequest>()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const lease: ResourceLease = { signal: new AbortController().signal, release, uncertain }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { acquire = (request: ResourceRequest) => {
    requested.resolve(request)
    return grant.promise
  } }(ctx)
  const events = join(root, 'events.jsonl'), barrier = join(root, 'release')
  await writeFile(events, '')
  const connection = startConnection(ctx, {
    transport: 'stdio', serverName: 'queued', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/negotiation-lifecycle.mjs', import.meta.url)), events, barrier],
    env: {}, cwd: root, toolCallTimeoutMs: 5_000, failOnStartupError: true,
  }, resolveReconnectPolicy({ enabled: false }, 'queued fixture'))
  onTestFinished(async () => {
    grant.resolve(lease)
    try { await connection.dispose(); await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const request = await requested.promise
  const stopping = connection.dispose()
  expect(request.signal?.aborted).toBe(true)
  grant.resolve(lease)
  await stopping
  expect((await connection.ready).error).toBeInstanceOf(Error)
  expect(await readFile(events, 'utf8')).toBe('')
  expect(release).toHaveBeenCalledOnce()
  expect(uncertain).not.toHaveBeenCalled()
})

it('retains its namespace after enclosing-owner cleanup fails and releases it after a confirmed retry', async () => {
  const ctx = new Context()
  let reportingUnavailable = false
  onTestFinished(async () => { reportingUnavailable = false; await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { logged.mockRestore() })
  let allocation = 0
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { async acquire() {
    const index = ++allocation
    return {
      signal: new AbortController().signal, async uncertain() {},
      async release() { if (reportingUnavailable && index === 2) throw new Error('completion storage unavailable') },
    }
  } }(ctx)
  const config = McpClient.Config({
    transport: 'stdio', serverName: 'retained', command: process.execPath,
    args: ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./fixture-server.ts', import.meta.url))],
    failOnStartupError: true, reconnect: { enabled: false }, processGraceMs: 50, processCloseTimeoutMs: 5_000,
  })
  let mounted: McpClient.McpClientHandle | undefined
  const fiber = await ctx.plugin({
    name: 'owned-mcp-fixture',
    inject: McpClient.inject,
    async apply(inner: Context) { mounted = McpClient.mountMcpClient(inner, config); await mounted.ready },
  })
  expect(allocation).toBe(2)
  reportingUnavailable = true
  await expect(mounted?.dispose()).rejects.toThrow('MCP managed process cleanup failed')
  await fiber.dispose()
  await expect(ctx.plugin(McpClient, config)).rejects.toThrow('already in use')
  expect(allocation).toBe(2)
  reportingUnavailable = false
  await mounted?.dispose()
  const replacement = await ctx.plugin(McpClient, config)
  await replacement.dispose()
}, 20_000)

it.each(['method-not-found', 'close'])('discovers a legacy server without initializing its disposable probe: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-mcp-legacy-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const events = join(root, 'events.jsonl'), release = join(root, 'release')
  await writeFile(events, '')
  await writeFile(release, '')
  const connection = startConnection(ctx, {
    transport: 'stdio', serverName: 'admission-legacy', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/negotiation-lifecycle.mjs', import.meta.url)), events, release, mode],
    env: {}, cwd: root, toolCallTimeoutMs: 5_000, failOnStartupError: true,
    processGraceMs: 50, processCloseTimeoutMs: 5_000, startupTimeoutMs: 10_000,
  }, resolveReconnectPolicy({ enabled: false }, 'admission fixture'))
  onTestFinished(async () => { await connection.dispose() })
  expect(await connection.ready).toEqual({})
  const observed = (await readFile(events, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { event: string; pid: number; previousAlive?: boolean })
  const starts = observed.filter(event => event.event === 'start')
  expect(starts).toHaveLength(2)
  expect(starts[1]?.previousAlive).toBe(false)
  expect(observed.filter(event => event.event === 'initialize').map(event => event.pid)).toEqual([starts[1]?.pid])
  await connection.dispose()
}, 20_000)

it('admits and drains its real modern discovery before publishing its serving process', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let allocated = 0, released = 0
  const uncertain = vi.fn(async () => {})
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { async acquire() {
    allocated++
    let done = false
    return { signal: new AbortController().signal, uncertain, async release() { if (!done) { done = true; released++ } } }
  } }(ctx)
  const connection = startConnection(ctx, {
    transport: 'stdio', serverName: 'admission-modern', command: process.execPath,
    args: ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./fixture-server.ts', import.meta.url))],
    env: {}, cwd: process.cwd(), toolCallTimeoutMs: 5_000, failOnStartupError: true,
    processGraceMs: 50, processCloseTimeoutMs: 5_000, startupTimeoutMs: 10_000,
  }, resolveReconnectPolicy({ enabled: false }, 'admission fixture'))
  onTestFinished(async () => { await connection.dispose() })
  expect(await connection.ready).toEqual({})
  expect(allocated).toBe(2)
  expect(released).toBe(1)
  expect(ctx.tools.schemas().some(tool => tool.name === 'mcp__admission-modern__greet')).toBe(true)
  await connection.dispose()
  expect(released).toBe(allocated)
  expect(uncertain).not.toHaveBeenCalled()
}, 20_000)
