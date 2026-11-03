/** Real SDK, automatic compaction, governance outbox and model admission with controlled external authority. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionAuthority } from '@deepseek-ai/dsh-execution-authority'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['llm', 'agents', 'sessions', 'loader']

/** Own deterministic transport and authorization while the shipped model and compaction plugins execute. */
export async function apply(ctx) {
  const phase = process.env.DSH_GOVERNANCE_PHASE, change = process.env.DSH_GOVERNANCE_CHANGE
  assert.ok(['preparation', 'grant', 'authorization', 'physical', 'none'].includes(phase))
  assert.ok(['same', 'different', 'inputs', 'primary', 'none'].includes(change))
  const active = new Set(), admissions = []
  let state = { revision: 'same-revision', inputs: ['10000000-0000-4000-8000-000000000007'],
    actors: [{ userId: 7 }, { userId: 8 }], primaryActorUserId: 7, unverifiedHistory: false }
  let generation = 0, paused = false, primary = 0, compactionEntries = 0, compactionPhysical = 0
  let summaries = 0, closed = 0, failed = 0, replacementsDuringCompaction = 0, seedSeq
  class Authority extends ExecutionAuthority {
    constructor(context) { super(context); this.generation = generation++ }
    current() { return undefined }
    async authorize(_capability, agent, signal) {
      signal?.throwIfAborted()
      if (this.generation > 0 && active.has(agent.id)) replacementsDuringCompaction++
      return structuredClone(state)
    }
  }
  ctx.provide('executionAuthorityRequired', true)
  const issuer = await ctx.plugin(Authority)
  const pause = async () => {
    if (paused) return
    paused = true
    const marker = join(process.cwd(), 'governance-pending.json')
    await writeFile(marker + '.tmp', JSON.stringify({ phase, change }))
    await rename(marker + '.tmp', marker)
    const deadline = AbortSignal.timeout(50_000)
    while (!existsSync(join(process.cwd(), 'governance-continue'))) await delay(10, undefined, { signal: deadline })
    if (change === 'different' || change === 'inputs') state = { ...state, inputs: ['10000000-0000-4000-8000-000000000008'] }
    if (change === 'different' || change === 'primary') state = { ...state, primaryActorUserId: 8 }
    if (change === 'same' || change === 'different') { await issuer.dispose(); await ctx.plugin(Authority) }
  }
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'compaction/start') active.add(_session.id)
    if (event.type === 'compaction/summary') summaries++
    if (event.type === 'compaction/end') { active.delete(_session.id); closed++; if (event.data.error !== undefined) failed++ }
    if (event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.startsWith('Preserve this project policy.'))) seedSeq = event.seq
  })
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', {
    async acquire(request) {
      const admission = { released: false }
      admissions.push(admission)
      if (phase === 'grant' && active.has(request.sessionId)) await pause()
      return { signal: new AbortController().signal,
        release: async () => { assert.equal(admission.released, false); admission.released = true },
        uncertain: async () => { throw new Error('Governance fixture must settle its model permits') } }
    },
  })
  if (phase === 'authorization') ctx.on('llm/authorize', async options => {
    if (options.purpose === 'compaction') await pause()
  }, { global: true })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 128 } }
    async prepareCall(...args) {
      const prepared = await super.prepareCall(...args)
      if (phase === 'preparation' && active.size > 0) await pause()
      return prepared
    }
    async *stream(options, dispatchRequest) {
      const auxiliary = options.purpose === 'compaction'
      if (auxiliary) {
        compactionEntries++
        if (phase === 'physical') await pause()
      }
      await dispatchRequest(async () => { if (auxiliary) compactionPhysical++ })
      const text = auxiliary ? 'Owned project policy preserved.' : ++primary === 1 ? 'GOVERNANCE_SEED_DONE' : 'GOVERNANCE_NEXT_DONE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: auxiliary ? 20000 : primary === 1 ? 20000 : 2000, outputTokens: 8 }, credentialSource: 'organization' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['governance-fixture'], new Adapter()))
  const home = process.env.DSH_HOME
  assert.equal(typeof home, 'string')
  await mkdir(home, { recursive: true })
  const policy = join(home, 'model-governance.json'), previous = process.env.DSH_MODEL_GOVERNANCE
  process.env.DSH_MODEL_GOVERNANCE = policy
  ctx.effect(() => () => {
    if (previous === undefined) delete process.env.DSH_MODEL_GOVERNANCE
    else process.env.DSH_MODEL_GOVERNANCE = previous
  })
  await writeFile(policy, JSON.stringify({ version: 1, defaultAllowed: false, userDeclaredAllowed: false,
    models: [{ provider: 'governance-fixture', model: 'governance-model', allowed: true }], providers: [],
    intakeUrl: 'http://127.0.0.1:1/usage', intakeToken: 'owned-governance-fixture' }))
  if (process.env.DSH_EXAMPLE_MODE === 'src') {
    const governance = await import('../../../../../plugins/dsh-model-governance/src/index.ts')
    await ctx.plugin(governance)
  } else await ctx.loader.create({ name: '@deepseek-ai/dsh-model-governance' })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (primary < 2) return
    const directory = join(home, 'model-governance-outbox')
    const records = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
    const usage = records.map(record => ({ purpose: record.purpose, actor: record.actorUserId,
      inputs: record.executionInputIds, status: record.status })).sort((a, b) => a.purpose.localeCompare(b.purpose) || a.actor - b.actor || a.inputs.join('|').localeCompare(b.inputs.join('|')))
    await writeFile(join(process.cwd(), 'governance-observation.json'), JSON.stringify({ phase, change, primary,
      compactionEntries, compactionPhysical, summaries, closed, failed, replacementsDuringCompaction,
      seedRetained: agent.session.surface.nodes.includes(seedSeq), admissions: admissions.length,
      released: admissions.filter(admission => admission.released).length, usage,
    }))
  })
  ctx.provide('governanceExecutionReady', true)
}
