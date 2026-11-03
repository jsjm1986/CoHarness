/** Loader model requests retain admission ownership and classified admission failures. */
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [mode, artifactRoot] = process.argv.slice(2)
if (mode !== 'src' && mode !== 'lib') throw new Error('Resource owner replay requires src or lib.')
const root = new URL('../../../../../', import.meta.url)
const entry = path => mode === 'lib' && artifactRoot !== undefined && path === 'llm/llm'
  ? pathToFileURL(resolve(artifactRoot, 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { boot } = await import(entry('boot/app-boot'))
const llm = await import(entry('llm/llm'))
const { ResourceAdmissionError } = await import(entry('context/resource-budget'))
let wireCalls = 0, ctx
const server = createServer((_request, response) => { wireCalls++; response.writeHead(200).end('{}') })
try {
  await new Promise((ready, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ready) })
  const endpoint = `http://127.0.0.1:${server.address().port}/model`
  const config = join(process.cwd(), 'cordis.yml')
  await writeFile(config, JSON.stringify([{ name: entry('llm/llm') }]))
  ctx = await boot('model-resource-owner', config)
  ctx.effect(() => ctx.provide('resourceBudgetRequired', true))
  for (const [phase, change] of [['queued', 'withdrawn'], ['queued', 'replaced'], ['physical-request', 'replaced']]) {
    const entered = Promise.withResolvers(), grant = Promise.withResolvers(), proceed = Promise.withResolvers()
    let admissions = 0, releases = 0, uncertainties = 0, adapterCalls = 0, replacementAdmissions = 0
    wireCalls = 0
    const lease = { signal: new AbortController().signal, release: async () => { releases++ },
      uncertain: async () => { uncertainties++ } }
    const withdraw = ctx.effect(() => ctx.provide('resourceBudget', { async acquire() {
      admissions++
      if (phase === 'queued') { entered.resolve(); return grant.promise }
      return lease
    } }))
    class Adapter extends llm.LlmAdapter {
      async *stream(_options, dispatch) {
        adapterCalls++
        if (phase === 'physical-request') { entered.resolve(); await proceed.promise }
        await dispatch(async () => { const response = await fetch(endpoint); await response.text() })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const unregister = ctx.effect(() => ctx.llm.registerAdapter(['owned-route'], new Adapter()))
    const streaming = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({ provider: 'owned-route', model: 'm', messages: [] })) chunks.push(chunk)
      return chunks
    })()
    let replacement
    try {
      await Promise.race([entered.promise, streaming.then(() => { throw new Error('Model request did not reach its controlled wait.') })])
      await withdraw()
      if (change === 'replaced') replacement = ctx.effect(() => ctx.provide('resourceBudget', { async acquire() {
        replacementAdmissions++; return lease
      } }))
      grant.resolve(lease); proceed.resolve()
      const last = (await streaming).at(-1)
      const reason = last?.type === 'finish' ? last.reason : undefined
      console.log(JSON.stringify({ phase, change, finish: reason?.kind ?? null, code: reason?.failure?.code ?? null,
        adapterCalls, wireCalls, admissions, releases, uncertainties, replacementAdmissions }))
    } finally {
      grant.resolve(lease); proceed.resolve(); await streaming
      await unregister(); await replacement?.(); await withdraw()
    }
  }
  for (const admissionReason of ['unavailable', 'cancelled', 'expired', 'refused']) {
    let admissions = 0, adapterCalls = 0
    wireCalls = 0
    const withdraw = ctx.effect(() => ctx.provide('resourceBudget', { async acquire() {
      admissions++
      throw new ResourceAdmissionError(admissionReason, 'Local resource admission failed.')
    } }))
    class Adapter extends llm.LlmAdapter {
      async *stream(_options, dispatch) {
        adapterCalls++
        await dispatch(async () => { const response = await fetch(endpoint); await response.text() })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const unregister = ctx.effect(() => ctx.llm.registerAdapter(['refused-route'], new Adapter()))
    try {
      let last
      for await (const chunk of ctx.llm.stream({ provider: 'refused-route', model: 'm', messages: [] })) last = chunk
      const reason = last?.type === 'finish' ? last.reason : undefined
      console.log(JSON.stringify({ phase: 'admission-failure', admissionReason,
        finish: reason?.kind ?? null, code: reason?.failure?.code ?? null, admissions, adapterCalls, wireCalls }))
    } finally { await unregister(); await withdraw() }
  }
} finally {
  await ctx?.fiber.dispose()
  if (server.listening) {
    server.closeAllConnections()
    await new Promise((ready, fail) => { server.close(error => error ? fail(error) : ready()) })
  }
}
