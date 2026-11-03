/** Real title provider and governance under Runtime infrastructure admission. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionAuthority } from '@deepseek-ai/dsh-execution-authority'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as FirstPromptTitle from '@deepseek-ai/dsh-session-title-first-prompt-llm'

export const inject = ['llm', 'agents', 'sessions', 'sessionTitle', 'loader']

/** Mount deterministic authority and transport around the actual title and governance services. */
export async function apply(ctx) {
  const phase = process.env.DSH_TITLE_PHASE, caller = process.env.DSH_TITLE_CALLER
  assert.ok(['prepare', 'admission'].includes(phase))
  assert.ok(['same', 'foreign'].includes(caller))
  const admissions = [], authorizations = []
  let actor = 7, blocked = false, primary = 0, titlePhysical = 0, titleAccepted = false, titleError = null
  let mainSession, titleOptions, liveOwner = false
  const input = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`
  const release = join(process.cwd(), 'title-continue')
  async function hold() {
    assert.equal(blocked, false)
    blocked = true
    const ready = join(process.cwd(), 'title-pending.json')
    await writeFile(ready + '.tmp', JSON.stringify({ phase, caller }))
    await rename(ready + '.tmp', ready)
    const signal = AbortSignal.timeout(50_000)
    while (!existsSync(release)) await delay(10, undefined, { signal })
    actor = 8
  }
  class Authority extends ExecutionAuthority {
    stamp() { throw new Error('Title fixture has no input transport') }
    answer() { throw new Error('Title fixture has no questions') }
    runCaptured() { throw new Error('Title fixture has no execution callbacks') }
    runRequest() { throw new Error('Title fixture has no command transport') }
    capture() { throw new Error('Title fixture has no delegation') }
    current() { return undefined }
    captureSession() { throw new Error('Title fixture has no cold forks') }
    inherit() { throw new Error('Title fixture has no inherited work') }
    relay() { throw new Error('Title fixture has no relay') }
    authorize() {
      authorizations.push(actor)
      return Promise.resolve({ revision: String(actor), inputs: [input(actor)], actors: [{ userId: actor }], primaryActorUserId: actor, unverifiedHistory: false })
    }
    authorizeSelection() { throw new Error('Title fixture has no selection') }
  }
  ctx.provide('executionAuthorityRequired', true)
  await ctx.plugin(Authority)
  ctx.provide('resourceBudget', { acquire: async request => {
    const row = { origin: request.origin ?? 'execution', sessionId: request.sessionId, released: false }
    admissions.push(row)
    if (request.origin === 'infrastructure' && phase === 'admission') await hold()
    return { signal: new AbortController().signal, release: async () => { assert.equal(row.released, false); row.released = true },
      uncertain: async () => { throw new Error('Title model permits must settle') } }
  } })
  const otherSession = Session.create(SessionId('foreign-title-caller'))
  const other = { id: otherSession.id, session: otherSession, ctx }
  ctx.effect(() => ctx.agents.enter(other, undefined))
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      if (model === 'title-model' && phase === 'prepare' && !blocked) await hold()
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 128 }
    }
    async *stream(options, dispatchRequest) {
      const title = options.purpose === 'session-title'
      await dispatchRequest(async () => { if (title) titlePhysical++; else primary++ })
      if (title) titleOptions = options
      else {
        mainSession = ctx.sessions.get(options.sessionId)
        assert.ok(mainSession)
        liveOwner = ctx.agents.get(mainSession.id) !== undefined
        await ctx.plugin(FirstPromptTitle, { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096,
          maxOutputTokens: 32, timeoutMs: 60000, provider: 'runtime-title-fixture', model: 'title-model' })
        const refresh = () => ctx.sessionTitle.refresh(mainSession)
        try {
          const accepted = await (caller === 'foreign' ? ctx.agents.withInitiator(other, refresh) : refresh())
          titleAccepted = accepted?.title === 'Runtime title accepted'
        } catch (error) { titleError = error.code ?? error.name }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title ? 'Runtime title accepted' : 'TITLE_INFRASTRUCTURE_DONE' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 }, credentialSource: 'organization' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['runtime-title-fixture'], new Adapter()))
  const home = process.env.DSH_HOME; assert.ok(home)
  const intake = createServer((request, response) => { request.resume(); response.writeHead(503); response.end() })
  await new Promise((ready, fail) => { intake.once('error', fail); intake.listen(0, '127.0.0.1', ready) })
  ctx.effect(() => () => new Promise((done, fail) => {
    intake.closeAllConnections(); intake.close(error => error ? fail(error) : done())
  }))
  const intakeUrl = `http://127.0.0.1:${intake.address().port}/usage`
  const path = join(home, 'title-model-governance.json'), previous = process.env.DSH_MODEL_GOVERNANCE
  process.env.DSH_MODEL_GOVERNANCE = path
  ctx.effect(() => () => { if (previous === undefined) delete process.env.DSH_MODEL_GOVERNANCE; else process.env.DSH_MODEL_GOVERNANCE = previous })
  await writeFile(path, JSON.stringify({ version: 1, defaultAllowed: false, userDeclaredAllowed: false,
    models: ['main-model', 'title-model'].map(model => ({ provider: 'runtime-title-fixture', model, allowed: true })),
    providers: [], intakeUrl, intakeToken: 'fixture-token' }))
  if (process.env.DSH_EXAMPLE_MODE === 'src') await ctx.plugin(await import('../../../../../plugins/dsh-model-governance/src/index.ts'))
  else await ctx.loader.create({ name: '@deepseek-ai/dsh-model-governance' })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent.session !== mainSession) return
    const directory = join(home, 'model-governance-outbox')
    const records = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
    const usage = records.map(row => ({ purpose: row.purpose, actor: row.actorUserId ?? null,
      inputs: row.executionInputIds ?? [], sameSession: row.sessionId === mainSession.id, status: row.status }))
      .sort((a, b) => a.purpose.localeCompare(b.purpose))
    const request = mainSession.snapshotEvents().find(event => event.type === 'session/title-llm-request')?.data
    const exactRequest = titleOptions !== undefined && request !== undefined
      && request.route.provider === titleOptions.provider && request.route.model === titleOptions.model
      && request.system === titleOptions.system && request.maxTokens === titleOptions.maxTokens
      && JSON.stringify(request.messages) === JSON.stringify(titleOptions.messages)
    const observed = { phase, caller, blocked, liveOwner, primary, titlePhysical, titleAccepted, titleError, exactRequest,
      authorizationsAfterChange: authorizations.filter(value => value === 8).length,
      admissions: admissions.map(row => ({ origin: row.origin, sameSession: row.sessionId === mainSession.id, released: row.released })), usage }
    const output = join(process.cwd(), 'title-observation.json')
    await writeFile(output + '.tmp', JSON.stringify(observed)); await rename(output + '.tmp', output)
  })
  ctx.provide('titleInfrastructureReady', true)
}
