/** Real Loader, Agent, file credentials and native search transports retain dispatch ownership. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const owned = new Set(['web/web', 'web/web-search-deepseek', 'web/web-search-perplexity'])
const entry = path => artifactRoot !== undefined && owned.has(path)
  ? pathToFileURL(resolve(artifactRoot, 'packages', path, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const secret = 'fixture-search-owner-secret-never-log', reference = 'COHARNESS_TEST_SEARCH_OWNER_KEY'
let ctx, credentialGate, unblock, active, mainCalls = 0
const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const part of request) chunks.push(part)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.ok(active)
    active.http++
    assert.ok(JSON.stringify(body).includes(active.query))
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url === '/deepseek/messages'
      ? { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://result.test', title: 'Result' }] }] }
      : { citations: ['https://result.test'] }))
  })().catch(error => response.destroy(error))
})
try {
  const { boot } = await import(entry('boot/app-boot'))
  const { SessionId } = await import(entry('core/session'))
  const { LlmAdapter } = await import(entry('llm/llm'))
  const { default: ResourceBudget } = await import(entry('context/resource-budget'))
  const { default: LocalCredentials } = await import(entry('credentials/credentials-local'))
  const { credentialRef } = await import(entry('credentials/credentials'))
  class Credentials extends LocalCredentials {
    async resolve(ref) {
      const gate = credentialGate
      if (gate !== undefined) {
        credentialGate = undefined; gate.entered.resolve(); await gate.proceed.promise
      }
      return super.resolve(ref)
    }
  }
  const config = join(process.cwd(), 'cordis.yml')
  await writeFile(config, JSON.stringify([
    ...['core/session', 'core/agent', 'llm/llm', 'core/tools', 'core/system-prompt', 'session/session-projection', 'web/web']
      .map(path => ({ name: entry(path) })),
    { name: entry('core/agent-loop'), config: { agents: [] } },
  ]))
  ctx = await boot('model-search-owner', config)
  await ctx.plugin(Credentials, { path: join(process.cwd(), 'credentials.yaml'), dshHome: process.cwd(), watch: false })
  await ctx.credentials.set(credentialRef(reference), secret)
  class MainModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() { mainCalls++; throw new Error('Independent search called the Session model') }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['fixture-main'], new MainModel()))
  const parent = await ctx.agentLoop.create(SessionId('search-owner-parent'), { provider: 'fixture-main', model: 'fixture' })
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const cases = [
    ...['withdrawn', 'replaced'].map(change => ({ phase: 'admission', change })),
    ...['withdrawn', 'replaced', 'policy', 'installed'].map(change => ({ phase: 'credential', change })),
    { phase: 'unchanged', change: 'managed' }, { phase: 'unchanged', change: 'independent' },
  ]
  for (const backend of ['deepseek', 'perplexity']) {
    for (const { phase, change } of cases) {
      let originalAcquires = 0, originalReleases = 0, replacementAcquires = 0, policy, replacement, fresh
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), requests = []
      unblock = () => proceed.resolve()
      const recordsBefore = parent.session.snapshotEvents().length
      active = { query: `${backend} ${phase} ${change}`, http: 0 }
      const lease = () => {
        let released = false
        return { signal: new AbortController().signal,
          release: async () => { if (!released) { released = true; originalReleases++ } },
          uncertain: async () => { throw new Error('Unexpected model request uncertainty') } }
      }
      class Budget extends ResourceBudget {
        async acquire(request) {
          assert.equal(request.kind, 'model'); assert.equal(request.origin, 'execution')
          requests.push(request.sessionId); originalAcquires++
          if (phase === 'admission') { entered.resolve(); await proceed.promise }
          return lease()
        }
      }
      const registration = change === 'independent' || change === 'installed' ? undefined : await ctx.plugin(Budget)
      let provider
      try {
        await ctx.loader.create({ id: `${backend}-${phase}-${change}`, name: entry(`web/web-search-${backend}`), config: {
          apiKeyEnv: reference, baseURL: `${origin}/${backend}`, model: backend === 'deepseek' ? 'fixture-search' : 'sonar', maxTokens: 32,
        } })
        provider = [...ctx.loader.entries()].find(row => row.options.id === `${backend}-${phase}-${change}`)
        assert.ok(provider?.fiber); await provider.fiber.await()
        if (phase === 'credential') credentialGate = { entered, proceed }
        const pending = ctx.agents.withInitiator(parent, () => ctx.web.search({ query: active.query }))
          .then(result => ({ success: true, result }), error => ({ success: false, error }))
        if (phase !== 'unchanged') await entered.promise
        if (change === 'policy') policy = ctx.effect(() => ctx.provide('modelAccessRequired', true))
        if (change === 'withdrawn' || change === 'replaced') await registration.dispose()
        if (change === 'replaced' || change === 'installed') replacement = ctx.effect(() => ctx.provide('resourceBudget', {
          async acquire() { replacementAcquires++; return lease() },
        }))
        proceed.resolve()
        const outcome = await pending
        const records = parent.session.snapshotEvents().slice(recordsBefore).filter(event => event.type === `web/${backend}-search-llm-request`).length
        console.log(JSON.stringify({ backend, phase, change,
          rejected: !outcome.success && outcome.error.code === 'WEB_PROVIDER_ERROR', http: active.http, records,
          originalAcquires, originalReleases, replacementAcquires,
          sessionMatched: requests.every(id => id === parent.id), secretLogged: JSON.stringify(parent.session.snapshotEvents()).includes(secret),
        }))
        if (!outcome.success) {
          assert.equal(outcome.error.code, 'WEB_PROVIDER_ERROR')
          await policy?.(); await replacement?.(); await registration?.dispose()
          fresh = await ctx.plugin(Budget)
          const before = active.http
          const result = await ctx.agents.withInitiator(parent, () => ctx.web.search({ query: active.query }))
          assert.equal(result.sources.length, 1); assert.equal(active.http - before, 1)
        }
      } finally {
        proceed.resolve(); credentialGate = undefined
        await provider?.fiber?.dispose(); await fresh?.dispose(); await policy?.(); await replacement?.(); await registration?.dispose()
      }
    }
  }
  assert.equal(mainCalls, 0)
} finally {
  unblock?.()
  try { await ctx?.fiber.dispose() } finally {
    if (server.listening) await new Promise(ready => { server.closeAllConnections(); server.close(ready) })
  }
}
