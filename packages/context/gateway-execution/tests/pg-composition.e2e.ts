/** Keyless Loader integration backed by a disposable PostgreSQL Gateway. */
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import GatewayRuntime, { GATEWAY_PRINCIPAL_HEADER, type GatewayRuntimeCredential } from '@deepseek-ai/dsh-gateway-runtime'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import PermissionPresets, { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as AutoReview from '@deepseek-ai/dsh-experimental-auto-review'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ExecutionQuestionId } from '@deepseek-ai/dsh-execution-authority'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Shell from '@deepseek-ai/dsh-shell'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GatewayExecution from '../src/index.ts'
import { executionInputOf, executionState, inputDigest } from '../src/input.ts'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import TerminalController, { type WebTerminalId, type TerminalAttachmentId, type TerminalFrame } from '@deepseek-ai/dsh-api-terminal-controller'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { errors.push(error) }
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (errors.length > 0) throw new AggregateError(errors, 'PostgreSQL Loader cleanup failed')
})

interface Ready {
  ready: true
  credential: GatewayRuntimeCredential
  admin: number
  member: number
  principals: { admin: string; member: string; terminalAdmin: string }
}

async function gateway() {
  if (!process.env.HGW_TEST_DATABASE_URL) throw new Error('HGW_TEST_DATABASE_URL must select a disposable PostgreSQL database')
  const child: ChildProcess = fork(join(root, 'gateway/tests/execution-fixture-server.ts'), [], {
    cwd: root, silent: true,
    execArgv: ['--import', import.meta.resolve('tsx/esm')],
    env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'tsconfig.json') },
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  let nextId = 0
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>()
  const ready = Promise.withResolvers<Ready>()
  const exited = Promise.withResolvers<Error | undefined>()
  child.on('message', (message: unknown) => {
    if (message === null || typeof message !== 'object') return
    if ('ready' in message && message.ready === true) { ready.resolve(message as Ready); return }
    if (!('id' in message) || typeof message.id !== 'number') return
    const request = pending.get(message.id)
    if (request === undefined) return
    pending.delete(message.id)
    if ('error' in message) request.reject(new Error(String(message.error)))
    else request.resolve('value' in message ? message.value : undefined)
  })
  child.once('error', (error) => { ready.reject(error); exited.resolve(error) })
  child.once('exit', (code) => {
    const error = new Error(`Gateway fixture exited (${String(code)}): ${stderr}`)
    ready.reject(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    exited.resolve(code === 0 ? undefined : error)
  })
  const command = (action: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const id = ++nextId, request = Promise.withResolvers<unknown>()
    pending.set(id, request)
    child.send({ id, action, ...extra }, (error) => { if (error) request.reject(error) })
    return request.promise
  }
  cleanup.push(async () => {
    if (child.exitCode === null && child.connected) {
      await command('stop')
      child.disconnect()
    }
    const error = await exited.promise
    if (error !== undefined) throw error
  })
  return { ...await ready.promise, command }
}

/** Shell is required by preset composition but every command is forbidden in this fixture. */
class UnusedShell extends Shell {
  override get sandboxMode() { return 'workspace-write' as const }
  resolve(): never { throw new Error('fixture does not run shell commands') }
  run(): never { throw new Error('fixture does not run shell commands') }
  start(): never { throw new Error('fixture does not run shell commands') }
}

class Connection extends HostConnectionService {
  constructor(ctx: Context) { super(ctx, []) }
}

class ScriptedModel extends LlmAdapter {
  script: Array<'tool' | 'job-output' | 'text' | 'hold'> = []
  readonly reviews: GenerateOptions[] = []
  readonly entered = Promise.withResolvers<undefined>()
  readonly cancelled = Promise.withResolvers<undefined>()
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'auto-review') {
      this.reviews.push(options)
      const text = '{"risk":"low","decision":"allow"}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const action = this.script.shift()
    if (action === 'hold') {
      this.entered.resolve(undefined)
      try {
        await new Promise<never>((_resolve, reject) => {
          const signal = options.signal
          if (signal === undefined) { reject(new Error('real model request must have cancellation')); return }
          const abort = (): void => { reject(new Error('fixture model aborted', { cause: signal.reason })) }
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      } finally { this.cancelled.resolve(undefined) }
    }
    if (action === 'tool' || action === 'job-output') {
      const name = action === 'tool' ? 'privileged_probe' : 'job_output'
      const args = action === 'tool' ? '{}' : JSON.stringify({ job_id: 'bash-1' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`managed-${name}`), name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (action === 'text') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'finished' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else throw new Error('model fixture script exhausted')
  }
}

async function composition(credential: GatewayRuntimeCredential, goals = false, jobsAndAuto = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-execution-pg-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const credentialFile = join(directory, 'runtime.json')
  await writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 })
  vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FILE', credentialFile)
  vi.stubEnv('DSH_GATEWAY_CREDENTIAL_FD', undefined)
  const configFile = join(directory, 'cordis.yml')
  const config = await readFile(new URL('./fixtures/postgres.cordis.yml', import.meta.url), 'utf8')
  await writeFile(configFile, config + (jobsAndAuto
    ? "- name: '@deepseek-ai/dsh-jobs-local'\n- name: '@deepseek-ai/dsh-tool-jobs'\n- name: '@deepseek-ai/dsh-experimental-auto-review'\n" : '') + (goals ? "- name: '@deepseek-ai/dsh-goal'\n- name: '@deepseek-ai/dsh-goal-round-driver'\n" : ''))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry], ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
    ['@deepseek-ai/dsh-experimental-auto-review', AutoReview],
    ['@deepseek-ai/dsh-goal', GoalService], ['@deepseek-ai/dsh-goal-round-driver', GoalRoundDriver],
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-session-query-sqlite', SessionQuery],
    ['fixture:unused-shell', UnusedShell], ['@deepseek-ai/dsh-user-approval', Approval],
    ['@deepseek-ai/dsh-permission-presets', PermissionPresets], ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicy],
    ['fixture:connection', Connection], ['@deepseek-ai/dsh-gateway-runtime', GatewayRuntime], ['@deepseek-ai/dsh-gateway-execution', GatewayExecution],
  ])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configFile).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  expect(ctx.executionAuthority).toBeInstanceOf(GatewayExecution)
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['fixture'], model)
  const writes: string[] = []
  const attempts: SessionId[] = []
  ctx.tools.register(defineContentToolFixture({ name: 'privileged_probe', description: 'Write the owned privileged probe', parameters: {},
    async execute() {
      attempts.push(ctx.agents.requireInitiator().id)
      await ctx.get('pluginManagementAuthorization')!.authorize()
      writes.push('authorized')
      await writeFile(join(directory, 'privileged.txt'), writes.join('\n'))
      return [{ type: 'text', text: 'written' }]
    },
  }))
  const send = async (agent: Agent, assertion: string, text: string): Promise<void> => {
    await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: '/api/test/send',
      headers: { [GATEWAY_PRINCIPAL_HEADER]: assertion } }, async () => {
      const message = await ctx.executionAuthority.stamp(agent.session,
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      agent.followup(message)
    })
  }
  return { ctx, model, writes, attempts, send, directory }
}

// The dedicated keyless command rejects a missing database before Vitest; the
// general provider inventory can discover this suite without provisioning one.
describe.skipIf(process.env.HGW_TEST_DATABASE_URL === undefined)('Gateway execution through Loader and PostgreSQL', () => {
  it('keeps a real user PTY private and waits for termination after PostgreSQL revocation', async () => {
    const server = await gateway(), world = await composition(server.credential)
    const { ctx } = world
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(TerminalController, TerminalController.Config({ shell: { path: process.execPath, name: 'Node REPL', args: ['--interactive'] } } as Parameters<typeof TerminalController.Config>[0]))
    const sessionId = SessionId(String(await server.command('session')))
    const agent = (await ctx.agents.create({ sessionId, meta: { cwd: world.directory }, agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
    await vi.waitFor(async () => {
      await expect(ctx.executionAuthority.authorize('execute', agent)).rejects.toThrow(/Gateway refused/)
    })
    const asHuman = async <T>(assertion: string, action: () => Promise<T>, method = 'test'): Promise<T> => {
      let result!: T
      await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: `/api/terminal/${method}`,
        headers: { [GATEWAY_PRINCIPAL_HEADER]: assertion } }, async () => { result = await action() })
      return result
    }
    const terminal = 'creator-private-pty' as WebTerminalId, attachment = 'human-view' as TerminalAttachmentId
    const create = () => ctx.terminalController.create(agent, { id: terminal, cols: 80, rows: 24 }, new AbortController().signal)
    await expect(asHuman(server.principals.member, create)).rejects.toMatchObject({ code: 'terminal/forbidden' })
    await server.command('terminal-enable')
    let handle: SubprocessTerminalHandle | undefined
    const spawn = Reflect.get(LocalSubprocessRuntime.prototype, 'spawnTerminal')
    vi.spyOn(LocalSubprocessRuntime.prototype, 'spawnTerminal').mockImplementation(async function (this: LocalSubprocessRuntime, spec) {
      handle = await spawn.call(this, spec)
      return handle
    })
    await vi.waitFor(async () => {
      await asHuman(server.principals.member, () => ctx.terminalController.authorizeSession(sessionId, new AbortController().signal))
    })
    const created = await asHuman(server.principals.member, create)
    expect(created.id).toBe(terminal)
    const signal = new AbortController().signal
    await expect(asHuman(server.principals.admin, () => ctx.terminalController.adminList(signal))).rejects.toMatchObject({ code: 'terminal/forbidden' })
    const inventory = await asHuman(server.principals.terminalAdmin, () => ctx.terminalController.adminList(signal), 'adminList')
    expect(inventory).toEqual([{ ownerId: expect.any(String) as string, sessionId, id: terminal, creatorUserId: server.member, state: 'running' }])
    await expect(asHuman(server.principals.terminalAdmin, () => ctx.terminalController.list(sessionId), 'adminList')).rejects.toMatchObject({ code: 'terminal/forbidden' })
    const originalHandle = handle
    const extra = 'admin-closed-pty' as WebTerminalId
    await asHuman(server.principals.member, () => ctx.terminalController.create(agent, { id: extra, cols: 80, rows: 24 }, signal))
    const extraHandle = handle
    const owned = inventory[0]
    if (owned === undefined) throw new Error('expected the terminal inventory entry')
    await asHuman(server.principals.terminalAdmin, () => ctx.terminalController.adminClose(owned.ownerId, extra, signal), 'adminClose')
    await extraHandle!.done
    handle = originalHandle
    expect((await asHuman(server.principals.member, () => ctx.terminalController.list(sessionId))).map(item => item.id)).toEqual([terminal])

    expect(handle).toBeDefined()
    expect(await asHuman(server.principals.admin, () => ctx.terminalController.list(sessionId))).toEqual([])
    await expect(asHuman(server.principals.admin, () => ctx.terminalController.write(agent, terminal, attachment, 'forbidden'))).rejects.toMatchObject({ code: 'terminal/unavailable' })
    const stream = ctx.terminalController.follow(agent, terminal, attachment, new AbortController().signal)[Symbol.asyncIterator]()
    try {
      const opening = await asHuman(server.principals.member, () => stream.next())
      expect((opening.value as TerminalFrame | undefined)?.type).toBe('snapshot')
      const target = join(world.directory, 'terminal-created.txt')
      await asHuman(server.principals.member, () => ctx.terminalController.write(agent, terminal, attachment,
        `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'terminal-owner')\r`))
      await vi.waitFor(async () => { expect(await readFile(target, 'utf8')).toBe('terminal-owner') })
      expect(world.model.script).toEqual([])
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
      await server.command('revoke')
      await handle!.done
      await ctx.terminalController.drainRevoked()
      await expect(asHuman(server.principals.member, create)).rejects.toMatchObject({ code: 'terminal/forbidden' })
      expect(await readFile(target, 'utf8')).toBe('terminal-owner')
    } finally { await stream.return?.() }
  }, 30_000)

  it('lets a new Auto request read a completed earlier job as historical data', async () => {
    const server = await gateway(), world = await composition(server.credential, false, true)
    const { ctx, model } = world
    const sessionId = SessionId(String(await server.command('session')))
    const agent = (await ctx.agents.create({ sessionId, meta: { cwd: world.directory },
      agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
    await vi.waitFor(async () => {
      await expect(ctx.executionAuthority.authorize('execute', agent)).rejects.toThrow(/Gateway refused/)
    })
    model.script.push('text')
    await world.send(agent, server.principals.member, 'ordinary work')
    await agent.whenIdle()
    const original = ctx.executionAuthority.capture(agent)
    const done = Promise.withResolvers<JobOutcome>()
    const id = ctx.executionAuthority.runCaptured(agent, original, () => ctx.jobs.start({
      kind: 'bash', label: 'earlier work', owner: agent,
      run: () => ({ done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }),
    }))
    const collected = ctx.jobs.wait(id, 5000, agent)
    done.resolve({ status: 'completed', output: 'historical output from the ordinary participant' })
    expect((await collected).status).toBe('completed')
    expect(agent.inbox.nextStep).toHaveLength(0)
    await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: '/api/test/permission',
      headers: { [GATEWAY_PRINCIPAL_HEADER]: server.principals.admin } }, async () => {
      await ctx.executionAuthority.authorizeSelection(agent, AUTO_PRESET)
      ctx.permissionPresets.set(agent.session, AUTO_PRESET)
    })
    model.script.push('job-output', 'tool', 'text')
    await world.send(agent, server.principals.admin, 'Read the completed old job and write the privileged probe.')
    await agent.whenIdle()
    expect(world.writes).toEqual(['authorized'])
    expect(await readFile(join(world.directory, 'privileged.txt'), 'utf8')).toBe('authorized')
    expect(model.reviews).toHaveLength(2)
    expect(model.reviews.map(review => review.executionIdentity?.primaryActorUserId)).toEqual([server.admin, server.admin])
    expect(ctx.executionAuthority.capture(agent).inputs).not.toContain(original.inputs[0])
    await expect(ctx.executionAuthority.runCaptured(agent, original, () => ctx.executionAuthority.authorize('auto-review', agent)))
      .rejects.toThrow(/Gateway refused/)
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result'
      && JSON.stringify(event.data).includes('historical output from the ordinary participant'))).toBe(true)
  }, 30_000)

  it('refuses a legacy pending question rather than replacing a newer independent scope', async () => {
    const server = await gateway(), world = await composition(server.credential)
    const { ctx, model } = world
    const sessionId = SessionId(String(await server.command('session')))
    const agent = (await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
    await vi.waitFor(async () => {
      await expect(ctx.executionAuthority.authorize('execute', agent)).rejects.toThrow(/Gateway refused/)
    })
    await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: '/api/test/send',
      headers: { [GATEWAY_PRINCIPAL_HEADER]: server.principals.member } }, async () => {
      const message = await ctx.executionAuthority.stamp(agent.session,
        createUserMessage({ content: [{ type: 'text', text: 'legacy ordinary request' }], source: { kind: 'user' } }))
      const response = await ctx.gatewayRuntime.request('/internal/runtime/execution/enter', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          sessionId, inputId: executionInputOf(message), messageId: message.id, contentHash: inputDigest(message.content),
        }),
      })
      expect(response.status).toBe(200)
      const state = executionState(await response.json())
      expect(state.scopeId).toBeUndefined()
      agent.session.append('gateway/execution', { kind: 'accepted', state })
    })
    const original = ctx.executionAuthority.capture(agent)
    expect(original.inputs).toHaveLength(1)
    model.script.push('text')
    await world.send(agent, server.principals.admin, 'fresh qualified request')
    await agent.whenIdle()
    const current = ctx.executionAuthority.capture(agent)
    expect(current.scopeId).toBeDefined()
    const reply = () => ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: '/api/test/respond',
      headers: { [GATEWAY_PRINCIPAL_HEADER]: server.principals.admin } }, async () => {
      await ctx.executionAuthority.answer(agent.session, 'legacy-question' as ExecutionQuestionId, { yes: true }, original)
    })
    await expect(reply()).rejects.toThrow('question execution scope is unavailable')
    expect(ctx.executionAuthority.capture(agent)).toEqual(current)
    expect((await ctx.executionAuthority.authorize('auto-review', agent)).actors).toEqual([{ userId: server.admin }])
  }, 30_000)

  it('preserves a queued independent request when the current actor loses project access', async () => {
    const server = await gateway(), world = await composition(server.credential)
    const { ctx, model } = world
    const sessionId = SessionId(String(await server.command('session')))
    const agent = (await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
    await vi.waitFor(async () => {
      await expect(ctx.executionAuthority.authorize('execute', agent)).rejects.toThrow(/Gateway refused/)
    })
    model.script.push('hold')
    await world.send(agent, server.principals.member, 'work until access is revoked')
    await model.entered.promise
    model.script.push('tool', 'text')
    await world.send(agent, server.principals.admin, 'independent qualified request')
    expect(agent.inbox.nextTurn).toHaveLength(1)
    await server.command('revoke')
    await model.cancelled.promise
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(world.writes).toEqual([])
    model.script.push('text')
    await world.send(agent, server.principals.admin, 'continue the queued request')
    await vi.waitFor(() => { expect(world.writes).toEqual(['authorized']) })
    await agent.whenIdle()
    expect(await readFile(join(world.directory, 'privileged.txt'), 'utf8')).toBe('authorized')
    expect((await ctx.executionAuthority.authorize('auto-review', agent)).actors).toEqual([{ userId: server.admin }])
  }, 30_000)

  it('binds real automatic Goal rounds to the activating human instead of the preceding participant', async () => {
    const server = await gateway(), world = await composition(server.credential, true)
    const { ctx, model } = world
    const sessionId = SessionId(String(await server.command('session')))
    const agent = (await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
    await vi.waitFor(async () => {
      await expect(ctx.executionAuthority.authorize('execute', agent)).rejects.toThrow(/Gateway refused/)
    })
    model.script.push('text')
    await world.send(agent, server.principals.member, 'ordinary previous participant')
    await agent.whenIdle()
    model.script.push('tool', 'text')
    await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname: '/api/goals/create',
      headers: { [GATEWAY_PRINCIPAL_HEADER]: server.principals.admin } }, async () => {
      await ctx.executionAuthority.runRequest(agent, { goal: 'write the privileged probe' }, () => {
        ctx.goals.create(agent, { objective: 'write the privileged probe', maxGoalRounds: 1 })
      })
    })
    await vi.waitFor(() => { expect(world.writes).toEqual(['authorized']) })
    await agent.whenIdle()
    expect(await readFile(join(world.directory, 'privileged.txt'), 'utf8')).toBe('authorized')
    expect((await ctx.executionAuthority.authorize('auto-review', agent)).actors).toEqual([{ userId: server.admin }])
    expect(ctx.goals.get(agent)?.roundsStarted).toBe(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'gateway/continuation')).toBe(true)
    const rounds = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'goal')
    expect(rounds).toHaveLength(1)
    expect(JSON.stringify(rounds[0])).toContain('gatewayExecutionScope')
    expect(ctx.executionAuthority.capture(agent).scopeId).toMatch(/^[0-9a-f-]{36}$/u)
  }, 30_000)

  it('runs a qualified new request after an ordinary historical participant without weakening inherited denial', async () => {
    const server = await gateway(), world = await composition(server.credential)
    const { ctx, model } = world
    const sessionId = SessionId(String(await server.command('session')))
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const agent = handle.agent
    await vi.waitFor(async () => {
      await expect(ctx.executionAuthority.authorize('execute', agent)).rejects.toThrow(/Gateway refused/)
    })
    model.script.push('tool', 'text')
    await world.send(agent, server.principals.member, 'ordinary participant request')
    await agent.whenIdle()
    const prior = ctx.executionAuthority.capture(agent)
    expect(world.writes).toEqual([])
    model.script.push('tool', 'text')
    await world.send(agent, server.principals.admin, 'qualified new request')
    await agent.whenIdle()
    expect(world.writes).toEqual(['authorized'])
    expect(await readFile(join(world.directory, 'privileged.txt'), 'utf8')).toBe('authorized')
    expect((await ctx.executionAuthority.authorize('auto-review', agent)).actors).toEqual([{ userId: server.admin }])
    await expect(ctx.executionAuthority.runCaptured(agent, prior,
      () => ctx.executionAuthority.authorize('auto-review', agent))).rejects.toThrow(/Gateway refused/)
    const transcript = agent.session.snapshotEvents().flatMap((event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'user') return [`user: ${event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')}`]
      if (event.type === 'tool/result') return event.data.message.content.flatMap(block => block.type === 'tool-result'
        ? [`tool ${block.isError ? 'denied' : 'authorized'}: ${block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('')}`] : [])
      if (event.type === 'assistant/message') return event.data.message.content.flatMap(block => block.type === 'text' ? [`assistant: ${block.text}`] : [])
      return []
    }).join('\n') + '\n'
    await expect(transcript).toMatchFileSnapshot('./snapshots/current-request.txt')
    const accepted = agent.session.snapshotEvents().filter(event => event.type === 'gateway/execution')
    expect(accepted.some(event => event.data.kind === 'accepted' && event.data.state.scopeId !== undefined)).toBe(true)
  }, 30_000)

  it('rejects mixed-actor tools, retains child restrictions, and cancels active work on revocation', async () => {
    const server = await gateway(), world = await composition(server.credential)
    const { ctx, model } = world
    const parentId = SessionId(String(await server.command('session')))
    const parent = (await ctx.agents.create({ sessionId: parentId, agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
    // A server refusal for the empty actor set proves watch readiness without
    // granting fixture authority or assuming HTTP/IPC request ordering.
    await vi.waitFor(async () => {
      await expect(ctx.executionAuthority.authorize('execute', parent)).rejects.toThrow(/Gateway refused/)
    })
    model.script.push('tool', 'text')
    await world.send(parent, server.principals.admin, 'admin probe')
    await parent.whenIdle()
    expect(world.writes).toEqual(['authorized'])
    expect(world.attempts).toEqual([parent.id])
    model.script.push('tool', 'text')
    await world.send(parent, server.principals.member, 'member probe')
    await parent.whenIdle()
    expect(world.writes).toEqual(['authorized'])
    expect(world.attempts).toEqual([parent.id, parent.id])
    expect(JSON.stringify(parent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)))
      .toContain('Gateway refused')
    expect(ctx.executionAuthority.capture(parent).inputs).toHaveLength(1)
    const scope = ctx.executionAuthority.capture(parent)
    const childId = SessionId(String(await server.command('session', { parentSessionId: parentId })))
    const child = (await ctx.agents.create({ sessionId: childId, parentAgent: parent,
      meta: { parentSession: parentId }, agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (_agentCtx, agent) => { ctx.executionAuthority.inherit(agent.session, scope) },
    })).agent
    model.script.push('tool', 'text')
    await world.send(child, server.principals.admin, 'child probe')
    await child.whenIdle()
    expect(world.writes).toEqual(['authorized'])
    expect(world.attempts).toEqual([parent.id, parent.id, child.id])
    expect(model.script).toEqual([])
    expect((await ctx.executionAuthority.authorize('execute', child)).actors).toEqual([
      { userId: server.admin }, { userId: server.member },
    ])
    model.script.push('hold')
    await world.send(child, server.principals.admin, 'wait for cancellation')
    await model.entered.promise
    expect(child.status).toBe('running')
    await server.command('revoke')
    await model.cancelled.promise
    await child.whenIdle()
    expect(child.status).toBe('idle')
    await expect(ctx.executionAuthority.authorize('execute', child)).rejects.toThrow(/Gateway refused/)
  }, 30_000)
})
