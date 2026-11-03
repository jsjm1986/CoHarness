/** Loader-composed external member refusals with an exhausted parent resource provider. */
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
if (mode !== 'src' && mode !== 'lib') throw new Error('Opaque admission requires src or lib.')
const root = new URL('../../../../../', import.meta.url)
const entry = path => mode === 'lib' && artifactRoot !== undefined
  && ['subagent/subagent', 'subagent/subagent-acp', 'subagent/subagent-claude-code'].includes(path)
  ? pathToFileURL(resolve(artifactRoot, path.split('/').at(-1), 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const { LlmAdapter } = await import(entry('llm/llm'))
const { ResourceAdmissionError } = await import(entry('context/resource-budget'))
const stateDir = join(process.cwd(), 'external-members')
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify([
  { name: entry('core/session') }, { name: entry('core/tools') }, { name: entry('core/system-prompt') },
  { name: entry('session/session-persistence-jsonl'), config: { root: join(process.cwd(), 'sessions'), compression: 'none' } },
  { name: entry('session/session-projection') },
  { name: entry('fs/fs-local') }, { name: entry('session/working-directory') },
  { name: entry('subagent/subagent') }, { name: entry('subprocess/subprocess-local') },
  { name: entry('llm/llm') }, { name: entry('core/agent') },
  { name: entry('core/agent-loop'), config: { agents: [] } },
  { name: entry('subagent/subagent-acp'), config: { providerName: 'owned-acp', command: process.execPath,
    args: [], permission: 'reject', env: {}, stateDir, resume: true } },
  { name: entry('subagent/subagent-claude-code'), config: { providerName: 'owned-claude', stateDir } },
]))
const ctx = await boot('opaque-member-admission', config)
try {
  const attempts = []
  let waiting, modelReleases = 0
  const requirement = ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  const registration = ctx.effect(() => ctx.provide('resourceBudget', { async acquire(request) {
    attempts.push(request.kind)
    if (request.kind !== 'model') throw new ResourceAdmissionError('refused', 'Native processes must not request admission.')
    waiting.entered.resolve()
    return waiting.grant.promise
  } }))
  for (const name of ['owned-acp', 'owned-claude']) {
    const provider = ctx.subagents.getProvider(name)
    if (provider?.agentRouteDefaults === undefined) throw new Error('The external member route must be installed.')
    attempts.length = 0
    modelReleases = 0
    waiting = { entered: Promise.withResolvers(), grant: Promise.withResolvers() }
    const chunks = [], admitted = waiting
    const streaming = (async () => {
      for await (const chunk of ctx.llm.stream({ ...provider.agentRouteDefaults,
        sessionId: SessionId(`opaque-${name}`), resourceOrigin: 'execution', messages: [],
      })) chunks.push(chunk)
    })()
    let phase
    try {
      phase = await Promise.race([streaming.then(() => 'finished'), admitted.entered.promise.then(() => 'queued')])
    } finally {
      admitted.grant.resolve({ signal: new AbortController().signal, release: async () => { modelReleases++ },
        uncertain: async () => { throw new Error('The controlled model admission must settle.') } })
      await streaming
    }
    const finish = chunks.at(-1)
    console.log(JSON.stringify({ provider: name, finish: finish?.type === 'finish' ? finish.reason : null,
      modelAdmissionAttempts: attempts.filter(kind => kind === 'model').length,
      processAdmissionAttempts: attempts.filter(kind => kind === 'process').length,
      waitedForModelPermit: phase === 'queued', modelReleases }))
  }
  await registration(); await requirement()
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() { throw new Error('The fixture parent must not request a model') }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['opaque-fixture'], new Adapter()))
  const parent = await ctx.agentLoop.create(SessionId('opaque-authority-parent'), { provider: 'opaque-fixture', model: 'fixture' }, { cwd: process.cwd() })
  const child = await ctx.agentLoop.create(SessionId('opaque-authority-member'), { provider: 'opaque-fixture', model: 'fixture' }, { cwd: process.cwd() })
  const subprocess = ctx.subprocess, spawn = subprocess.spawn
  let nativeAttempts = 0
  ctx.effect(() => {
    subprocess.spawn = async () => {
      nativeAttempts++
      throw new Error('Fixture stopped opaque native allocation before any external inference')
    }
    return () => { subprocess.spawn = spawn }
  })
  const refused = async (work) => {
    try { await work(); return false } catch (error) { return error.code === 'UNSUPPORTED_CAPABILITY' }
  }
  for (const control of ['execution-owner', 'execution-required']) {
    const revoke = ctx.effect(() => control === 'execution-owner'
      ? ctx.provide('executionAuthority', {
        capture: () => ({ parentSessionId: parent.id, inputs: [], unverifiedHistory: false }),
        runCaptured: (_agent, _scope, work) => work(),
      }) : ctx.provide('executionAuthorityRequired', true))
    try {
      for (const name of ['owned-acp', 'owned-claude']) {
        nativeAttempts = 0
        const provider = ctx.subagents.getProvider(name)
        const signal = new AbortController().signal
        const started = await refused(async () => {
          const run = await ctx.subagents.start(name, { parent,
            prompt: [{ type: 'text', text: 'Verify opaque execution admission.' }], signal })
          await run.dispose()
        })
        const prepared = await refused(() => provider.prepareContinuable({ parent, sessionId: child.id, cwd: process.cwd(), signal }))
        const chunks = []
        for await (const chunk of ctx.llm.stream({ ...provider.agentRouteDefaults, sessionId: child.id, messages: [] })) chunks.push(chunk)
        const finish = chunks.at(-1)
        console.log(JSON.stringify({ provider: name, control, startRefused: started, memberRefused: prepared,
          finishCode: finish?.type === 'finish' && finish.reason.kind === 'error' ? finish.reason.failure.code : null,
          nativeAllocationAttempts: nativeAttempts }))
      }
    } finally { await revoke() }
  }
} finally { await ctx.fiber.dispose() }
