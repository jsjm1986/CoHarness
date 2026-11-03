import { execFile } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'
import { CodexMemberTransport } from '../src/member.ts'
import { recoverCodexThread } from '../src/rollout.ts'
import LlmRuntime, { createUserMessage, LlmError, MessageId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ExecutionInheritance } from '@deepseek-ai/dsh-execution-authority'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import type { CodexPermissionMode } from '../src/run.ts'
import {
  startResponsesFixture,
  type ResponsesBehavior,
  type ResponsesFixture,
} from './responses-fixture.ts'
import { cleanupRealProduct } from './real-product-cleanup.ts'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { parentAgent } from './agent-fixture.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const codexBinDir = join(packageRoot, 'node_modules', '.bin')
const codexPackageJson = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(
  codexPackageJson,
  'utf8',
)) as { version: string; bin: { codex: string } }
const codexEntry = resolve(dirname(codexPackageJson), codexPackage.bin.codex)
const codexPackageRoot = dirname(dirname(codexEntry))

const roots: string[] = []
const fixtures: ResponsesFixture[] = []
const contexts: Context[] = []

afterEach(() => cleanupRealProduct({ contexts, fixtures, roots }))

interface RealHarness {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly spawnSpecs: SubprocessSpawnSpec[]
  readonly parent: Agent
  readonly env: Record<string, string>
  readonly workspace: string
}

interface RealInstanceFixture {
  readonly fixture: ResponsesFixture
  readonly env: Record<string, string>
  readonly workspace: string
}

type ResponsesScript = readonly ResponsesBehavior[] | ((workspace: string) => readonly ResponsesBehavior[])

async function realInstanceFixture(
  script: ResponsesScript,
): Promise<RealInstanceFixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-real-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  mkdirSync(workspace)
  mkdirSync(codexHome)
  const fixture = await startResponsesFixture(typeof script === 'function' ? script(workspace) : script)
  fixtures.push(fixture)
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'disable_response_storage = true',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = "${fixture.baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    'apps = false',
    'plugins = false',
    'remote_plugin = false',
    'in_app_updates = false',
    '',
  ].join('\n'))
  const env = {
    OPENAI_API_KEY: 'dsh-fake-openai-key',
    CODEX_HOME: codexHome,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    PATH: `${codexBinDir}${delimiter}${process.env.PATH ?? ''}`,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
    ...process.platform === 'win32' && process.env.SystemRoot !== undefined
      ? { SystemRoot: process.env.SystemRoot }
      : {},
    ...process.platform === 'win32' && process.env.ComSpec !== undefined
      ? { ComSpec: process.env.ComSpec }
      : {},
  }
  return { fixture, env, workspace }
}

interface RealRuntime {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly spawnSpecs: SubprocessSpawnSpec[]
}

async function realRuntime(): Promise<RealRuntime> {
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const spawnSpecs: SubprocessSpawnSpec[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(async (spec) => {
    spawnSpecs.push(spec)
    const handle = await spawn(spec)
    handles.push(handle)
    return handle
  })
  return { ctx, handles, spawnSpecs }
}

async function realHarness(
  script: ResponsesScript,
  permissionMode?: CodexPermissionMode,
): Promise<{
  readonly harness: RealHarness
  readonly fixture: ResponsesFixture
}> {
  const instance = await realInstanceFixture(script)
  const { ctx, handles, spawnSpecs } = await realRuntime()
  await ctx.plugin(codex, {
    env: instance.env,
    ...permissionMode === undefined ? {} : { permissionMode },
    disposeGraceMs: 2_000,
  })
  const parent = parentAgent(instance.workspace, 'real-parent', ctx)
  return {
    harness: {
      ctx,
      handles,
      spawnSpecs,
      parent,
      env: instance.env,
      workspace: instance.workspace,
    },
    fixture: instance.fixture,
  }
}

async function managedHarness(script: ResponsesScript, inheritModel = false) {
  const instance = await realInstanceFixture(script)
  const runtime = await realRuntime()
  const ctx = runtime.ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(piAi, { providers: { 'managed-codex': {
    api: 'openai-responses', baseURL: instance.fixture.baseUrl,
    models: [{ id: 'fixture-model', maxTokens: 64 }],
    headers: { authorization: 'Bearer parent-only-fixture-credential' },
  } } })
  await ctx.plugin(codex, { env: instance.env,
    ...inheritModel ? {} : { modelProvider: 'managed-codex', model: 'fixture-model' },
    stateDir: join(instance.workspace, '.external-bindings'),
    permissionMode: 'dangerously-bypass-approvals-and-sandbox', disposeGraceMs: 2_000 })
  const parent: Agent = { ...parentAgent(instance.workspace, 'managed-parent', ctx),
    options: { provider: 'managed-codex', model: 'fixture-model' } }
  const requests: GenerateOptions[] = []
  const usage: Extract<StreamChunk, { type: 'usage' }>[] = []
  const failures: unknown[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args) => { failures.push(args) })
  ctx.on('llm/delegated-stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
    requests.push(options)
    for await (const chunk of next()) { if (chunk.type === 'usage') usage.push(chunk); yield chunk }
  })
  return { ...instance, ...runtime, parent, requests, usage, failures }
}

const managedToolTurn = [
  { kind: 'advertisedFunctionCall', choices: [
    { name: 'update_plan', arguments: { plan: [{ step: 'Record managed child request', status: 'completed' }] } },
    { name: 'exec_command', arguments: { cmd: 'printf managed-child' } },
    { name: 'shell_command', arguments: { command: 'printf managed-child' } },
  ] },
  { kind: 'complete', text: 'managed complete' },
] as const satisfies readonly ResponsesBehavior[]

async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

function expectedProcessExitDiagnostic(outcome: SubprocessOutcome): string {
  const fields = [
    'product: Codex',
    'stage: process',
    'category: process',
  ]
  if (outcome.exitCode !== null) fields.push(`exit code: ${outcome.exitCode}`)
  if (outcome.signal !== null) fields.push(`signal: ${outcome.signal}`)
  return `Product subagent failure (${fields.join('; ')})`
}

interface JsonSchemaNode {
  readonly properties?: Record<string, JsonSchemaNode>
  readonly required?: string[]
  readonly type?: string | string[]
}

function responseInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap((item): string[] => {
    if (item === null || typeof item !== 'object') return []
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part): string[] => (
      part !== null
      && typeof part === 'object'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    ))
  })
}

const admissionCases = (['model-policy', 'resource-owner', 'resource-required'] as const)
  .flatMap(admission => [false, true].map(inheritModel => ({ admission, inheritModel })))

function installAdmissionControls(ctx: Context, admission: typeof admissionCases[number]['admission']): void {
  if (admission === 'model-policy') {
    ctx.provide('modelAccessRequired', true)
    ctx.provide('modelAccess', { decide: (target: { provider: string }) => target.provider === 'managed-codex'
      ? { allowed: true as const } : { allowed: false as const, reason: 'Only the native upstream route is authorized.' },
    })
  } else {
    expect(ctx.get('modelAccess')).toBeUndefined()
    expect(ctx.get('modelAccessRequired')).toBeUndefined()
    if (admission === 'resource-required') ctx.provide('resourceBudgetRequired', true)
  }
}

describe('real @openai/codex 0.153.4 product', () => {
  it.each([true, false])('retains parent model checks with execution authority alone and allowed=%s', async (allowed) => {
    const f = await managedHarness([{ kind: 'complete', text: 'authority complete' }], true)
    const local = new AsyncLocalStorage<ExecutionInheritance>()
    const scope: ExecutionInheritance = { parentSessionId: f.parent.id, inputs: [], unverifiedHistory: false }
    f.ctx.provide('executionAuthority', { capture: () => scope, current: () => local.getStore(),
      runCaptured: <T>(_agent: unknown, saved: ExecutionInheritance, work: () => T): T => local.run(saved, work),
    })
    expect(f.ctx.get('resourceBudget')).toBeUndefined()
    expect(f.ctx.get('modelAccess')).toBeUndefined()
    let checks = 0
    f.ctx.on('llm/pre-dispatch', async (_options, next) => {
      expect(local.getStore()).toBe(scope)
      checks++
      if (!allowed) throw new LlmError('Execution authority refused the native model request.', 'MODEL_POLICY_UNAVAILABLE')
      await next()
    })
    const run = await local.run(scope, () => f.ctx.subagents.start('codex', { parent: f.parent,
      prompt: [{ type: 'text', text: 'Return the fixture marker without using tools.' }], signal: new AbortController().signal }))
    try {
      const result = await run.result
      expect(checks).toBeGreaterThan(0)
      expect(f.fixture.requests).toHaveLength(allowed ? 1 : 0)
      if (allowed) {
        expect(result).toMatchObject({ stopReason: 'completed', output: [{ type: 'text', text: 'authority complete' }] })
        expect(f.fixture.requests[0]?.headers.authorization).toBe('Bearer parent-only-fixture-credential')
      } else expect(result.stopReason).toBe('error')
    } finally { await run.dispose() }
    await expectQuiescent(f.handles)
  }, 30_000)

  it.each(admissionCases)('resumes managed persistent members under capacity one with $admission and inherited route=$inheritModel', async ({ admission, inheritModel }) => {
    const f = await managedHarness([...managedToolTurn, ...managedToolTurn], inheritModel)
    await f.ctx.plugin(AgentRegistry)
    const child = parentAgent(f.workspace, 'managed-persistent-member', f.ctx)
    f.ctx.effect(() => f.ctx.agents.register(child))
    const modelOwners: ResourceRequest[] = []
    let models = 0, processes = 0
    f.ctx.provide('resourceBudget', { acquire: async (request: ResourceRequest) => {
      const model = request.kind === 'model'
      if (model) {
        if (models !== 0) throw new Error('The single model permit is occupied by another request.')
        models += 1
        modelOwners.push(request)
      } else processes += 1
      let released = false
      return { signal: new AbortController().signal, release: async () => {
        if (released) return
        released = true
        if (model) models -= 1; else processes -= 1
      },
      uncertain: async () => { throw new Error('The managed member must release every native resource.') },
      }
    } })
    installAdmissionControls(f.ctx, admission)
    const provider = f.ctx.subagents.getProvider('codex')!
    await provider.prepareContinuable!({ parent: f.parent, sessionId: child.id, cwd: f.workspace, signal: new AbortController().signal })
    const metered: string[] = []
    f.ctx.on('llm/stream', async function* (options, next) { metered.push(options.provider); yield* next() })
    const first = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the fixture command and return the marker.' }] })
    const second = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the fixture command once more and return the marker.' }] })
    for (const messages of [[first], [first, second]]) {
      const call = await f.ctx.llm.prepareCall(provider.agentRouteDefaults!)
      const chunks: StreamChunk[] = []
      for await (const chunk of call.stream({ ...call.config, sessionId: child.id, messages })) chunks.push(chunk)
      expect(chunks.at(-1), JSON.stringify({ chunks, failures: f.failures })).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe('managed complete')
    }
    expect(f.fixture.requests).toHaveLength(4)
    expect(modelOwners).toHaveLength(4)
    expect(modelOwners.every(request => request.sessionId === child.id && request.origin === 'execution')).toBe(true)
    expect(f.requests.every(request => request.sessionId === child.id)).toBe(true)
    expect(child.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request')).toHaveLength(4)
    expect(f.parent.session.snapshotEvents()).toHaveLength(0)
    expect(metered).toEqual([])
    expect(f.spawnSpecs).toHaveLength(2)
    expect(f.spawnSpecs.every(spec => !Object.hasOwn(spec.env ?? {}, 'OPENAI_API_KEY'))).toBe(true)
    await expectQuiescent(f.handles)
    expect({ models, processes }).toEqual({ models: 0, processes: 0 })
  }, 60_000)

  it('refuses a forbidden registered model before allocating the native process', async () => {
    const f = await managedHarness([{ kind: 'complete', text: 'must not execute' }])
    f.ctx.provide('modelAccess', { decide: () => ({ allowed: false, reason: 'No models authorized' }) })
    await expect(f.ctx.subagents.start('codex', { parent: f.parent,
      prompt: [{ type: 'text', text: 'Return the marker.' }], signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'MODEL_FORBIDDEN' })
    expect(f.handles).toHaveLength(0)
    expect(f.fixture.requests).toHaveLength(0)
  })
  it.each(admissionCases)('meters native requests without child credentials with $admission and inherited route=$inheritModel', async ({ admission, inheritModel }) => {
    const f = await managedHarness(managedToolTurn, inheritModel)
    const modelOwners: unknown[] = []
    const admissions: Array<{ request: ResourceRequest; released: boolean }> = []
    const uncertain = vi.fn(async () => {})
    f.ctx.provide('resourceBudget', { acquire: async (request: ResourceRequest) => {
      const entry = { request, released: false }
      admissions.push(entry)
      if (request.kind === 'model') modelOwners.push(request)
      return { signal: new AbortController().signal, release: async () => { entry.released = true }, uncertain }
    } })
    installAdmissionControls(f.ctx, admission)
    const run = await f.ctx.subagents.start('codex', { parent: f.parent,
      prompt: [{ type: 'text', text: 'Run the fixture command and return the final marker.' }], signal: new AbortController().signal })
    try {
      const result = await run.result
      expect(result, JSON.stringify({ result, failures: f.failures, nativeRequests: f.requests.length,
        upstreamRequests: f.fixture.requests.length })).toMatchObject({ stopReason: 'completed', output: [{ type: 'text', text: 'managed complete' }] })
      expect(f.fixture.requests).toHaveLength(2)
      expect(f.fixture.requests.every(request => request.headers.authorization === 'Bearer parent-only-fixture-credential')).toBe(true)
      expect(modelOwners).toHaveLength(2)
      for (const owner of modelOwners) expect(owner).toMatchObject({ kind: 'model', sessionId: f.parent.id, origin: 'execution' })
      expect(f.requests.every(request => request.sessionId === f.parent.id)).toBe(true)
      expect(f.usage.map(chunk => chunk.usage.totalTokens)).toEqual([15, 11])
      expect(f.parent.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request')).toHaveLength(2)
      expect(f.spawnSpecs[0]?.env).not.toHaveProperty('OPENAI_API_KEY')
      expect(f.spawnSpecs[0]?.argv.join(' ')).not.toContain('parent-only-fixture-credential')
    } finally { await run.dispose() }
    await expectQuiescent(f.handles)
    expect(admissions).toHaveLength(3)
    expect(admissions.every(entry => entry.released)).toBe(true)
    expect(uncertain).not.toHaveBeenCalled()
  }, 30_000)

  it.each([false, true])('refuses the next native request after queued registration-policy revocation with isolated parent=%s', async (isolated) => {
    const f = await managedHarness(managedToolTurn)
    let allowed = true
    f.ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'revoked' } })
    const owner = isolated ? f.ctx.isolate('modelAccess') : f.ctx
    if (isolated) owner.provide('modelAccess', { decide: () => ({ allowed: true }) })
    const queued = Promise.withResolvers<undefined>()
    const deliver = Promise.withResolvers<undefined>()
    let models = 0
    f.ctx.provide('resourceBudget', { acquire: async (request: ResourceRequest) => {
      if (request.kind === 'model' && ++models === 2) { queued.resolve(undefined); await deliver.promise }
      return { signal: new AbortController().signal, release: async () => {}, uncertain: async () => {} }
    } })
    const run = await f.ctx.subagents.start('codex', { parent: { ...f.parent, ctx: owner },
      prompt: [{ type: 'text', text: 'Run the fixture command, then return the final marker.' }], signal: new AbortController().signal })
    try {
      await queued.promise
      allowed = false
      deliver.resolve(undefined)
      await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
      expect(f.fixture.requests).toHaveLength(1)
      expect(f.usage.map(chunk => chunk.usage.totalTokens)).toEqual([15])
      expect(f.requests).toHaveLength(2)
    } finally { deliver.resolve(undefined); await run.dispose() }
    await expectQuiescent(f.handles)
  }, 30_000)

  it('cancels a held managed native request and joins its process and model permits', async () => {
    const f = await managedHarness([{ kind: 'hold' }])
    const releases: string[] = []
    f.ctx.provide('resourceBudget', { acquire: async (request: ResourceRequest) => {
      let released = false
      return {
        signal: new AbortController().signal,
        release: async () => { if (!released) { released = true; releases.push(request.kind) } },
        uncertain: async () => { throw new Error('Managed native cancellation retained an uncertain permit') },
      }
    } })
    const controller = new AbortController()
    const run = await f.ctx.subagents.start('codex', { parent: f.parent,
      prompt: [{ type: 'text', text: 'Wait at the owned endpoint.' }], signal: controller.signal })
    try {
      await f.fixture.requestStarted
      controller.abort()
      await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    } finally { await run.dispose() }
    expect(releases.sort()).toEqual(['model', 'process'])
    await expectQuiescent(f.handles)
  }, 30_000)

  it.each([false, true])('refuses native inference with an isolated initiating Agent policy=%s', async (isolated) => {
    const { harness, fixture } = await realHarness([{ kind: 'complete', text: 'native model executed' }])
    const owner = isolated ? harness.ctx.isolate('modelAccess') : harness.ctx
    owner.provide('modelAccess', { decide: () => ({ allowed: false, reason: 'No models authorized' }) })
    const outcome = await harness.ctx.subagents.start('codex', {
      parent: { ...harness.parent, ctx: owner }, prompt: [{ type: 'text', text: 'Return the fixed fixture answer.' }],
      signal: new AbortController().signal,
    }).then(async (run) => { try { await run.result } finally { await run.dispose() } }).catch((error: unknown) => error)
    expect(fixture.requests).toHaveLength(0)
    expect(harness.handles).toHaveLength(0)
    expect(outcome).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  }, 30_000)

  it('recovers a completed persistent turn from the official rollout without another model request', async () => {
    const instance = await realInstanceFixture([{ kind: 'complete', text: 'RECOVERED_EXACT_TURN' }])
    const runtime = await realRuntime()
    const transport = new CodexMemberTransport({
      cwd: instance.workspace, permissionMode: 'never', env: instance.env, disposeGraceMs: 2_000,
    }, spec => runtime.ctx.subprocess.spawn(spec))
    const signal = new AbortController().signal
    const session = await transport.open(undefined, signal)
    const prompt = 'Return the recovery marker.'
    let turnId: string | undefined
    try {
      for await (const _piece of session.turn(prompt, signal, (id) => { turnId = id })) {
        /* terminal proof is read from the real rollout below */
      }
    } finally { await session.dispose() }
    expect(session.externalId).toBeTruthy()
    expect(turnId).toBeTruthy()
    if (turnId === undefined) throw new Error('Codex did not acknowledge the persistent turn')
    expect(recoverCodexThread(session.externalId!, {
      prompt, throughMessageId: MessageId('real-recovery'), externalTurnId: turnId,
    }, instance.env.CODEX_HOME)).toEqual({ kind: 'result', text: 'RECOVERED_EXACT_TURN' })
    expect(instance.fixture.requests).toHaveLength(1)
    await expectQuiescent(runtime.handles)
  }, 30_000)

  it('starts approve-for-me through the real app-server and returns exact text', async () => {
    const sentinel = 'REAL_CODEX_SENTINEL_0_149_1'
    const task = 'Return the fixture sentinel exactly.'
    const { harness, fixture } = await realHarness([
      { kind: 'complete', text: sentinel },
    ], 'approve-for-me')
    expect(codexPackage.version).toBe('0.153.4')
    const version = await execFileAsync(process.execPath, [codexEntry, '--version'], {
      env: { ...process.env, ...harness.env },
    })
    expect(version.stdout.trim()).toBe('codex-cli 0.153.4')
    const schemaRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-schema-'))
    roots.push(schemaRoot)
    await execFileAsync(process.execPath, [
      codexEntry,
      'app-server',
      'generate-json-schema',
      '--out',
      schemaRoot,
    ], { env: { ...process.env, ...harness.env } })
    const schema = JSON.parse(readFileSync(
      join(schemaRoot, 'ClientRequest.json'),
      'utf8',
    )) as {
      definitions: {
        ThreadStartParams: JsonSchemaNode
      }
    }
    expect(schema.definitions.ThreadStartParams.properties?.model).toEqual({
      type: ['string', 'null'],
    })
    expect(schema.definitions.ThreadStartParams.required).toBeUndefined()

    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: task }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: sentinel }],
      stopReason: 'completed',
    })
    await run.dispose()

    expect(harness.spawnSpecs[0]?.argv).toEqual([
      process.execPath,
      codexEntry,
      'app-server',
      '--stdio',
    ])

    expect(fixture.requests).toHaveLength(1)
    const recorded = fixture.requests[0]!
    expect(recorded.method).toBe('POST')
    expect(recorded.path).toBe('/v1/responses')
    expect(recorded.headers.authorization).toBe('Bearer dsh-fake-openai-key')
    expect(recorded.body.model).toBe('fixture-model')
    expect(responseInputTexts(recorded.body)).toContain(task)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('fails a missing platform payload without falling back to a host codex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-missing-payload-'))
    roots.push(root)
    const isolatedPackage = join(root, 'node_modules', '@openai', 'codex')
    mkdirSync(dirname(isolatedPackage), { recursive: true })
    cpSync(codexPackageRoot, isolatedPackage, { recursive: true, dereference: true })
    const isolatedEntry = join(isolatedPackage, 'bin', 'codex.js')

    await expect(execFileAsync(process.execPath, [isolatedEntry, '--version'], {
      env: {
        PATH: codexBinDir,
        ...process.platform === 'win32' && process.env.SystemRoot !== undefined
          ? { SystemRoot: process.env.SystemRoot }
          : {},
      },
    })).rejects.toThrow(/Missing optional dependency @openai\/codex-[a-z0-9-]+/)
  }, 30_000)

  it('runs two named instances concurrently and unloads one without revoking its run', async () => {
    const safeInstance = await realInstanceFixture([{ kind: 'hold' }])
    const bypassInstance = await realInstanceFixture([{
      kind: 'complete',
      text: 'NAMED_CODEX_BYPASS_RESULT',
    }])
    const { ctx, handles, spawnSpecs } = await realRuntime()
    const safeFiber = await ctx.plugin(codex, {
      providerName: 'codex-safe',
      model: 'codex-safe-model',
      env: safeInstance.env,
      permissionMode: 'never',
      disposeGraceMs: 2_000,
    })
    const bypassFiber = await ctx.plugin(codex, {
      providerName: 'codex-bypass',
      model: 'codex-bypass-model',
      env: bypassInstance.env,
      permissionMode: 'dangerously-bypass-approvals-and-sandbox',
      disposeGraceMs: 2_000,
    })
    const safeParent = parentAgent(safeInstance.workspace, 'safe-parent', ctx)
    const bypassParent = parentAgent(bypassInstance.workspace, 'bypass-parent', ctx)
    const safeController = new AbortController()

    const [safeRun, bypassRun] = await Promise.all([
      ctx.subagents.start('codex-safe', {
        prompt: [{ type: 'text', text: 'Hold the safe instance.' }],
        parent: safeParent,
        signal: safeController.signal,
      }),
      ctx.subagents.start('codex-bypass', {
        prompt: [{ type: 'text', text: 'Complete the bypass instance.' }],
        parent: bypassParent,
        signal: new AbortController().signal,
      }),
    ])
    await safeInstance.fixture.requestStarted
    await safeFiber.dispose()
    expect(ctx.subagents.list()).toEqual(['codex-bypass'])
    await expect(ctx.subagents.start('codex-safe', {
      prompt: [{ type: 'text', text: 'This start must fail.' }],
      parent: safeParent,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NO_PROVIDER' })

    await expect(bypassRun.result).resolves.toEqual({
      output: [{ type: 'text', text: 'NAMED_CODEX_BYPASS_RESULT' }],
      stopReason: 'completed',
    })
    safeController.abort(new Error('cancel only the published safe run'))
    await expect(safeRun.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    await Promise.all([safeRun.dispose(), bypassRun.dispose()])
    expect(safeInstance.fixture.requests).toHaveLength(1)
    expect(bypassInstance.fixture.requests).toHaveLength(1)
    expect(safeInstance.fixture.requests[0]?.body.model).toBe('codex-safe-model')
    expect(bypassInstance.fixture.requests[0]?.body.model).toBe('codex-bypass-model')
    expect(safeInstance.fixture.requests[0]?.body.input)
      .not.toEqual(bypassInstance.fixture.requests[0]?.body.input)
    expect(spawnSpecs.map(spec => spec.env?.CODEX_HOME).sort()).toEqual([
      safeInstance.env.CODEX_HOME,
      bypassInstance.env.CODEX_HOME,
    ].sort())
    await expectQuiescent(handles)
    await bypassFiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  }, 60_000)

  it('overrides on-request with never and reports a denied command safely', async () => {
    const command = process.platform === 'win32'
      ? 'cmd /c type nul > approval-side-effect'
      : 'touch approval-side-effect'
    const commandCalls = [
      {
        name: 'exec_command',
        arguments: {
          cmd: command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
      {
        name: 'shell_command',
        arguments: {
          command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
    ] as const
    const { harness, fixture } = await realHarness([
      {
        kind: 'advertisedFunctionCall',
        choices: commandCalls,
      },
      {
        kind: 'error',
        status: 400,
        message: 'fixture terminal failure after permission denial',
      },
    ])
    const sideEffect = join(harness.workspace, 'approval-side-effect')
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Attempt the fixture command.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    expect(result.output).toEqual([])
    expect(result.stopReason).toBe('error')
    const diagnosticLines = result.diagnostic?.split('\n') ?? []
    expect(diagnosticLines[0]).toBe(
      'Product subagent failure (product: Codex; stage: turn; category: product-error)',
    )
    expect(diagnosticLines).toHaveLength(1)
    expect(result.diagnostic).not.toContain(command)
    expect(result.diagnostic).not.toContain(harness.workspace)
    await run.dispose()

    expect(existsSync(sideEffect)).toBe(false)
    expect(fixture.requests).toHaveLength(2)
    const tools = fixture.requests[0]!.body.tools as Array<Record<string, unknown>>
    expect(commandCalls.some(call => tools.some(tool => (
      tool.type === 'function' && tool.name === call.name
    )))).toBe(true)
    expect(fixture.requests.every(requestEntry =>
      requestEntry.headers.authorization === 'Bearer dsh-fake-openai-key',
    )).toBe(true)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('reports a real service failure and an early app-server exit safely', async () => {
    {
      const { harness } = await realHarness([{
        kind: 'error',
        status: 503,
        message: 'SECRET_TOKEN in /private/secret.txt',
      }])
      const run = await harness.ctx.subagents.start('codex', {
        prompt: [{ type: 'text', text: 'Exercise the service failure path.' }],
        parent: harness.parent,
        signal: new AbortController().signal,
      })
      const result = await run.result
      expect(result).toMatchObject({ output: [], stopReason: 'error' })
      expect(result.diagnostic).toBe(
        'Product subagent failure (product: Codex; stage: turn; category: service)',
      )
      expect(result.diagnostic).not.toContain('SECRET_TOKEN')
      expect(result.diagnostic).not.toContain('/private/secret.txt')
      await run.dispose()
      await expectQuiescent(harness.handles)
    }
    {
      const { harness, fixture } = await realHarness([{ kind: 'hold' }])
      const run = await harness.ctx.subagents.start('codex', {
        prompt: [{ type: 'text', text: 'Exercise the process failure path.' }],
        parent: harness.parent,
        signal: new AbortController().signal,
      })
      await fixture.requestStarted
      expect(harness.handles).toHaveLength(1)
      harness.handles[0]!.terminate()
      const outcome = await harness.handles[0]!.done
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedProcessExitDiagnostic(outcome),
        stopReason: 'error',
      })
      await run.dispose()
      await expectQuiescent(harness.handles)
    }
  }, 60_000)

  it('executes an explicitly selected dangerous bypass write in the isolated workspace', async () => {
    const sideEffect = 'bypass-side-effect'
    const { harness, fixture } = await realHarness((workspace): readonly ResponsesBehavior[] => {
      const target = join(workspace, sideEffect)
      const command = process.platform === 'win32'
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${target.replaceAll("'", "''")}' -Value 'bypass' -NoNewline"`
        : `printf bypass > ${JSON.stringify(target)}`
      const commandCalls = [
        {
          name: 'exec_command',
          arguments: {
            cmd: command,
          },
        },
        {
          name: 'shell_command',
          arguments: {
            command,
          },
        },
      ] as const
      return [
        { kind: 'advertisedFunctionCall', choices: commandCalls },
        { kind: 'complete', text: 'bypass complete' },
      ]
    }, 'dangerously-bypass-approvals-and-sandbox')
    const target = join(harness.workspace, sideEffect)
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Create the fixture side effect.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'bypass complete' }],
      stopReason: 'completed',
    })
    // exec_command reports a session still running past the completed run:
    // the spawned shell writes the file after the result resolves.
    await expect
      .poll(() => existsSync(target), { message: JSON.stringify(fixture.requests.at(-1)?.body.input) })
      .toBe(true)
    expect(readFileSync(target, 'utf8').trim()).toBe('bypass')
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('settles cancellation locally and leaves the real app-server tree quiescent', async () => {
    const { harness, fixture } = await realHarness([{ kind: 'hold' }])
    const controller = new AbortController()
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Wait for cancellation.' }],
      parent: harness.parent,
      signal: controller.signal,
    })
    await fixture.requestStarted
    controller.abort(new Error('real product cancellation'))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)
})
