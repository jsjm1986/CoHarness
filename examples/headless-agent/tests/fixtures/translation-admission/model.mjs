/** Native translation retains the selected owner through real application admission. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { Config as OfficialConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'agents', 'sessions', 'sessionPersistence', 'loader']

/** Mount the actual native owner and translator; only external credentials and transport are fixtures. */
export async function apply(ctx) {
  const phase = process.env.DSH_TRANSLATION_PHASE
  const home = process.env.DSH_HOME; assert.ok(home)
  assert.ok(['allow', 'models', 'key', 'credentials', 'settings-models', 'settings-key', 'settings-initial'].includes(phase))
  const face = process.env.DSH_EXAMPLE_MODE === 'src' ? 'src/index.ts' : 'lib/index.js'
  const Translator = await import(new URL(`../../../../../packages/experimental/translator/${face}`, import.meta.url))
  const requests = [], admissions = [], handlers = new Set(), failures = []
  let endpoint, nativeAdmitted = false, changed = false, owner, settings
  const change = async () => {
    if (phase === 'settings-models' || phase === 'settings-key') {
      await settings.update('llm-deepseek', phase === 'settings-models'
        ? { models: [{ id: 'deepseek-flash', maxTokens: 4096 }] } : { apiKeyEnv: 'CHANGED_TRANSLATION_FIXTURE_KEY' })
      changed = true
      return
    }
    const proceed = Promise.withResolvers()
    queueMicrotask(() => {
      if (phase === 'key') owner.fiber.config.apiKeyEnv = OfficialConfig({ apiKeyEnv: 'CHANGED_TRANSLATION_FIXTURE_KEY' }).apiKeyEnv
      else owner.fiber.config.models = OfficialConfig({ models: [{ id: 'deepseek-flash', maxTokens: 4096 }] }).models
      changed = true
      proceed.resolve()
    })
    await proceed.promise
  }
  const configured = ref => phase !== 'settings-initial' || ref === 'EFFECTIVE_TRANSLATION_FIXTURE_KEY'
  ctx.provide('credentials', {
    describe: async ref => ({ configured: configured(ref), writable: false }),
    resolve: async ref => {
      if (phase === 'credentials' && nativeAdmitted && !changed) await change()
      return configured(ref) ? { value: 'fixture-native-key', source: 'fixture' } : undefined
    },
  })
  ctx.provide('resourceBudget', { async acquire(request) {
    const row = { native: request.sessionId === undefined, released: false }
    admissions.push(row)
    if (row.native) {
      nativeAdmitted = true
      if (['models', 'key', 'settings-models', 'settings-key'].includes(phase)) await change()
    }
    return { signal: new AbortController().signal,
      release: async () => { assert.equal(row.released, false); row.released = true },
      uncertain: async () => { throw new Error('Translation fixture must release every model permit.') } }
  } })
  ctx.effect(() => async () => { await Promise.all(handlers) })
  await applyLoopbackServerEffect(ctx, {
    label: 'translation-admission-fixture', onCleanup: () => {},
    onListening: address => { endpoint = `http://127.0.0.1:${address.port}/anthropic` },
    requestListener: (request, response) => {
      if (request.url === '/usage') { request.resume(); response.writeHead(503).end(); return }
      const pending = (async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        requests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          sessionHeader: request.headers['x-deepseek-harness-session-id'] !== undefined })
        const events = [
          { type: 'message_start', message: { id: 'translation', model: 'deepseek-flash', usage: { input_tokens: 3, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '翻译结果' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
          { type: 'message_stop' },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      })().catch(error => { failures.push(error); response.destroy() })
      handlers.add(pending)
      void pending.finally(() => handlers.delete(pending))
    },
  })
  owner = [...ctx.loader.entries()].find(entry => entry.options.id === 'llm-deepseek')
  assert.ok(owner)
  if (phase.startsWith('settings-')) {
    if (ctx.get('settings') === undefined) {
      const FileSettings = await import(new URL(`../../../../../packages/settings/settings-file/${face}`, import.meta.url))
      await ctx.plugin(FileSettings.default, { path: join(process.cwd(), 'translation-settings.json'), watch: false })
    }
    settings = ctx.get('settings')
    assert.ok(settings)
  }
  await owner.update({ disabled: false, name: '@deepseek-ai/dsh-llm-deepseek-api-key',
    config: { baseURL: endpoint, apiKeyEnv: 'TRANSLATION_FIXTURE_KEY', models: [{ id: 'deepseek-flash' }] } })
  if (phase === 'settings-initial') await settings.update('llm-deepseek', { apiKeyEnv: 'EFFECTIVE_TRANSLATION_FIXTURE_KEY' })
  await ctx.plugin(Translator.default)
  const translator = ctx.get('translator')
  assert.ok(translator)
  await writeFile(join(home, 'model-governance.json'), JSON.stringify({ version: 1, defaultAllowed: true,
    userDeclaredAllowed: false, models: [], providers: [], intakeUrl: new URL('/usage', endpoint).href,
    intakeToken: 'translation-fixture-token' }))
  if (process.env.DSH_EXAMPLE_MODE === 'src') await ctx.plugin(await import('../../../../../plugins/dsh-model-governance/src/index.ts'))
  else await ctx.loader.create({ name: '@deepseek-ai/dsh-model-governance' })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 512 }
    }
    async *stream(options, dispatchRequest) {
      await dispatchRequest(async () => {})
      const session = ctx.sessions.get(options.sessionId)
      assert.ok(session)
      const history = session.deriveMessages()
      const spec = translator.resolve({ text: 'Original paragraph', targetLanguage: 'zh',
        provider: 'deepseek-official', sessionId: session.id })
      let reply
      try { reply = await translator.translate(spec) }
      catch (error) { reply = error.code ?? error.name }
      const events = session.snapshotEvents()
      const outbox = join(home, 'model-governance-outbox')
      const usage = await Promise.all((await readdir(outbox)).filter(file => file.endsWith('.json')).map(async file =>
        JSON.parse(await readFile(join(outbox, file), 'utf8'))))
      const proof = { requests: requests.length, nativeAdmissions: admissions.filter(row => row.native).length,
        nativeReleased: admissions.filter(row => row.native && row.released).length,
        requestRecords: events.filter(event => event.type === 'plugin:translator/request').length,
        resultRecords: events.filter(event => event.type === 'plugin:translator/result').length,
        historyUnchanged: isDeepStrictEqual(history, session.deriveMessages()),
        independentInput: requests.every(request => request.sessionHeader === false && request.body.dsh_session_log === undefined
          && request.body.tools === undefined && isDeepStrictEqual(request.body.messages,
            [{ role: 'user', content: [{ type: 'text', text: 'Original paragraph' }] }])),
        transportErrors: failures.length,
        purposes: usage.filter(record => record.provider === 'deepseek-official').map(record => record.purpose) }
      await writeFile(join(process.cwd(), 'translation-proof.json'), JSON.stringify(proof))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['translation-fixture'], new Adapter()))
  ctx.provide('translationAdmissionReady', true)
}
