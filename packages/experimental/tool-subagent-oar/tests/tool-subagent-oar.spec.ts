import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { expect, it } from 'vitest'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import * as externalTool from '../src/index.ts'

async function setup(options: { jobs?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const calls: { provider: string; request: ResolvedSubagentStartRequest }[] = []
  for (const name of ['codex-provider', 'claude-provider', 'future-provider']) {
    ctx.subagents.registerProvider({
      name, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      start: async (request) => {
        calls.push({ provider: name, request })
        return {
          id: SessionId(randomUUID()),
          result: Promise.resolve({ output: [{ type: 'text' as const, text: 'child result' }], stopReason: 'completed' as const }),
          dispose: () => Promise.resolve(),
        }
      },
    })
  }
  const parent = await harness.create(SessionId(randomUUID()), {}, { cwd: process.cwd() })
  if (options.jobs !== false) {
    // Parent result delivery is the jobs seam; an unscoped attachment serves every owner.
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('tool-subagent-oar-test')
  }
  return { ctx, parent, calls }
}

it('selects one configured provider per call and exposes only task inputs', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  const fiber = await ctx.plugin(externalTool, {
    providers: { codex: 'codex-provider', claude: 'claude-provider', future: 'future-provider' },
  })
  const schema = ctx.tools.schemas().find(tool => tool.name === 'subagent_oar')
  expect(schema?.parameters.required).toEqual(['runtime', 'description', 'prompt'])
  expect(Object.keys(schema?.parameters.properties as Record<string, unknown>).sort()).toEqual(['cwd', 'description', 'name', 'prompt', 'runtime'])
  expect(schema?.parameters.properties).toMatchObject({ runtime: { enum: ['codex', 'claude', 'future'] } })
  for (const [runtime, name, expected] of [['codex', undefined, 'agent-1'], ['claude', 'reviewer', 'reviewer'], ['future', undefined, 'agent-2']] as const) {
    const result = await executeToolFixture(ctx, {
      agent: parent, name: 'subagent_oar', signal: test.signal,
      callId: ToolCallId(randomUUID()),
      arguments: { runtime, description: `Use ${runtime}`, prompt: 'independent task', ...name === undefined ? {} : { name } },
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: `started subagent ${expected}` }])
    if (!result.isError) {
      expect(result.value).toEqual({ kind: 'activation', name: expected })
      expect(ctx.tools.get('subagent_oar')?.output.presentationMeta?.({}, result.value))
        .toEqual({ kind: 'activation', name: expected })
    }
  }
  expect(calls.map(call => call.provider)).toEqual(['codex-provider', 'claude-provider', 'future-provider'])
  expect(calls[0]?.request.prompt).toEqual([{ type: 'text', text: 'independent task' }])
  expect(calls[0]?.request.parent).toBe(parent)
  expect(calls[0]?.request.cwd).toBe(process.cwd())
  expect(ctx.tools.get('subagent_oar')?.isConcurrencySafe?.({
    runtime: 'codex', description: 'task', prompt: 'task',
  })).toBe(true)
  await fiber.dispose()
  expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(false)
})

it('rejects unconfigured runtime names before starting any child', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'unconfigured', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(calls).toEqual([])
})

it('fails visibly when the selected provider disappears', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { missing: 'missing-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'missing', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(calls).toEqual([])
})

it('rejects empty runtime maps and keeps Loader metadata', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  expect('default' in externalTool).toBe(false)
  const loader = Object.create(Loader.prototype) as Loader
  expect(loader.unwrapExports(externalTool)).toBe(externalTool)
  await expect(ctx.plugin(externalTool, { providers: {} })).rejects.toThrow('at least one')
  await expect(ctx.plugin(externalTool, { providers: { ' ': 'codex-provider' } })).rejects.toThrow('non-empty')
})

it('requires a caller and independently scoped one-shot providers', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  ctx.subagents.registerProvider({
    name: 'inherited', capabilities: NO_START_CAPABILITIES, inheritsParentContext: true,
    start: async () => { throw new Error('must not run') },
  })
  await ctx.plugin(externalTool, { providers: { inherited: 'inherited' } })
  const args = { runtime: 'inherited', description: 'task', prompt: 'task' }
  const noParent = await executeToolFixture(ctx, {
    name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(noParent.isError).toBe(true)
  const inherited = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(inherited.isError).toBe(true)
  expect(JSON.stringify(inherited.content)).toContain('independent conversation')
})

it('passes an explicit child directory and presents the task description', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const args = { runtime: 'codex', description: 'Inspect child', prompt: 'task', cwd: 'packages' }
  expect(ctx.tools.get('subagent_oar')?.presentCall?.(args)).toEqual({
    card: 'generic', title: 'Inspect child', rawInput: args,
  })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(result.isError).toBe(false)
  expect(calls[0]?.request.cwd).toBe(join(process.cwd(), 'packages'))
})

it('supports direct composition with the declared optional defaults', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  externalTool.apply(ctx, { providers: { codex: 'codex-provider' } })
  expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(true)
})

it('rejects invalid and duplicate child names without starting a provider', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  for (const bad of ['lead', 'Bad_Name', '-leading-hyphen', `x${'x'.repeat(32)}`]) {
    const result = await executeToolFixture(ctx, {
      agent: parent, name: 'subagent_oar', signal: test.signal,
      callId: ToolCallId(randomUUID()),
      arguments: { runtime: 'codex', description: 'task', prompt: 'task', name: bad },
    })
    expect(result.isError, JSON.stringify({ bad, content: result.content })).toBe(true)
  }
  expect(calls).toEqual([])
  const first = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'codex', description: 'task', prompt: 'task', name: 'reviewer' },
  })
  expect(first.isError).toBe(false)
  const duplicate = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'codex', description: 'task', prompt: 'task', name: 'reviewer' },
  })
  expect(duplicate.isError).toBe(true)
  expect(JSON.stringify(duplicate.content)).toContain('already used')
  expect(calls).toHaveLength(1)
})

it('requires a job registry for parent delivery', async (test) => {
  const { ctx, parent, calls } = await setup({ jobs: false })
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'codex', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('job registry')
  expect(calls).toEqual([])
})

it('rejects a provider that also prepares continuable children', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  ctx.subagents.registerProvider({
    name: 'continuable-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: async () => { throw new Error('must not run') },
    prepareContinuable: async () => { throw new Error('must not run') },
  })
  await ctx.plugin(externalTool, { providers: { mixed: 'continuable-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'mixed', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('independent conversation')
})

it('aborts provider startup when the caller signal fires before publication', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  const external = new AbortController()
  ctx.subagents.registerProvider({
    name: 'blocking-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: request => new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => { reject(new Error('startup cancelled')) }, { once: true })
      external.abort()
    }),
  })
  await ctx.plugin(externalTool, { providers: { blocking: 'blocking-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: external.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'blocking', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
})

it('disposes a published run when job registration fails and frees the claimed name', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  const disposed: string[] = []
  ctx.subagents.registerProvider({
    name: 'disposable-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: async (request) => {
      calls.push({ provider: 'disposable-provider', request })
      return {
        id: SessionId(randomUUID()),
        result: Promise.reject(new Error('run lost')),
        dispose: () => {
          disposed.push(request.descriptor.provider)
          return Promise.reject(new Error('cleanup unavailable'))
        },
      }
    },
  })
  await ctx.plugin(externalTool, {
    providers: { codex: 'codex-provider', disposable: 'disposable-provider' },
  })
  // Retain a sibling name so the failed call's release leaves the set non-empty.
  const kept = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'codex', description: 'task', prompt: 'task', name: 'reviewer' },
  })
  expect(kept.isError).toBe(false)
  // Force job registration to refuse the next published run, and make the
  // retention hand-off itself reject so the disposal warning stands alone.
  ctx.jobs.start = () => { throw new Error('admission refused') }
  ctx.subagents.retainFailedCleanup = () => Promise.reject(new Error('retained elsewhere'))
  const failed = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'disposable', description: 'task', prompt: 'task' },
  })
  expect(failed.isError).toBe(true)
  expect(disposed).toEqual(['disposable-provider'])
  // The released default name is claimable again; a retained duplicate would
  // reject before the provider ever runs.
  const retry = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'disposable', description: 'task', prompt: 'task', name: 'agent-1' },
  })
  expect(retry.isError).toBe(true)
  expect(calls.filter(call => call.provider === 'disposable-provider')).toHaveLength(2)
})

it('reports failed cleanup in the job outcome and hands it back for the next admission', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  let disposals = 0
  ctx.subagents.registerProvider({
    name: 'flaky-cleanup-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: async (request) => {
      calls.push({ provider: 'flaky-cleanup-provider', request })
      return {
        id: SessionId(randomUUID()),
        result: Promise.resolve({ output: [{ type: 'text' as const, text: 'kept answer' }], stopReason: 'completed' as const }),
        dispose: () => {
          disposals += 1
          return disposals === 1 ? Promise.reject(new Error('cleanup detail')) : Promise.resolve()
        },
      }
    },
  })
  await ctx.plugin(externalTool, {
    providers: { flaky: 'flaky-cleanup-provider', codex: 'codex-provider' },
  })
  const first = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'flaky', description: 'task', prompt: 'task' },
  })
  expect(first.isError, JSON.stringify(first.content)).toBe(false)
  const job = ctx.jobs.list(parent.id).find(view => view.kind === 'subagent')
  expect(job).toBeDefined()
  const settled = await ctx.jobs.wait(job!.id, 5000, parent.id)
  expect(settled.status).toBe('failed')
  // The next admission for the same parent retries the retained cleanup first.
  const second = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'codex', description: 'task', prompt: 'task' },
  })
  expect(second.isError, JSON.stringify(second.content)).toBe(false)
  expect(disposals).toBe(2)
})

it('cancels a registered run through its job', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  let aborted = false
  let disposed = false
  ctx.subagents.registerProvider({
    name: 'long-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: async request => ({
      id: SessionId(randomUUID()),
      result: new Promise((resolve) => {
        request.signal.addEventListener('abort', () => {
          aborted = true
          resolve({ output: [], stopReason: 'aborted' as const })
        }, { once: true })
      }),
      dispose: () => { disposed = true; return Promise.resolve() },
    }),
  })
  await ctx.plugin(externalTool, { providers: { long: 'long-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'long', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(false)
  const job = ctx.jobs.list(parent.id).find(view => view.kind === 'subagent')
  expect(job).toBeDefined()
  expect(ctx.jobs.kill(job!.id, parent.id)).toBe('requested')
  const settled = await ctx.jobs.wait(job!.id, 5000, parent.id)
  expect(settled.status).toBe('killed')
  expect(aborted).toBe(true)
  expect(disposed).toBe(true)
})

it('swallows cancel-time and settlement disposal failures the run cannot confirm', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  let disposed = 0
  ctx.subagents.registerProvider({
    name: 'noisy-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: async request => ({
      id: SessionId(randomUUID()),
      result: new Promise((resolve) => {
        request.signal.addEventListener('abort', () => { resolve({ output: [], stopReason: 'aborted' as const }) }, { once: true })
      }),
      dispose: () => { disposed += 1; return Promise.reject(new Error('cleanup detail')) },
    }),
  })
  // The parent scope cannot accept retained cleanup; both hand-offs swallow it.
  ctx.subagents.retainFailedCleanup = () => Promise.reject(new Error('retained elsewhere'))
  await ctx.plugin(externalTool, { providers: { noisy: 'noisy-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'noisy', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(false)
  const job = ctx.jobs.list(parent.id).find(view => view.kind === 'subagent')
  expect(job).toBeDefined()
  expect(ctx.jobs.kill(job!.id, parent.id)).toBe('requested')
  const settled = await ctx.jobs.wait(job!.id, 5000, parent.id)
  expect(settled.status).toBe('failed')
  // Cancel and settlement may join the same memoized lease disposal.
  expect(disposed).toBeGreaterThanOrEqual(1)
})

it('registers under a configured tool name', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, {
    providers: { codex: 'codex-provider' },
    toolName: 'delegate_oar',
  })
  expect(ctx.tools.schemas().some(tool => tool.name === 'delegate_oar')).toBe(true)
})
