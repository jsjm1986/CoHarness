/** Actual native model HTTP, durable request checkpoint and SDK continuation. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'tools', 'credentials', 'sessions', 'sessionPersistence']

/** Install deterministic conversation output while the real native adapter and web tool execute. */
export async function apply(ctx, config = {}) {
  const sonar = config.protocol === 'sonar'
  const requestEvent = sonar ? 'web/perplexity-search-llm-request' : 'web/deepseek-search-llm-request'
  const { LlmAdapter, ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const { appendPluginRecord, SessionId, SessionLogOffset } = await import('@deepseek-ai/dsh-session')
  const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
  const admissions = [], usages = []
  let endpoint, calls = 0, nativeRequests = 0, persistedBeforeHttp = false
  if (!config.inheritParentAdmission) {
    ctx.provide('modelAccessRequired', true)
    ctx.provide('modelAccess', { decide: () => ({ allowed: true }) })
    ctx.provide('resourceBudgetRequired', true)
    ctx.provide('resourceBudget', {
      async acquire(request) {
        assert.equal(request.kind, 'model')
        assert.equal(typeof request.sessionId, 'string')
        const admission = { origin: request.origin, released: false }
        admissions.push(admission)
        return {
          signal: new AbortController().signal,
          release: async () => { admission.released = true },
          uncertain: async () => { throw new Error('Native SDK fixture retained an uncertain model permit') },
        }
      },
    })
  }
  ctx.on('llm/stream', async function* (options, next) {
    const inherited = config.inheritParentAdmission ? { origin: options.resourceOrigin, released: false } : undefined
    if (inherited !== undefined) admissions.push(inherited)
    try {
      for await (const chunk of next()) {
        if (options.purpose === 'web-search' && chunk.type === 'usage') {
          usages.push({ ...chunk.usage, credentialSource: chunk.credentialSource })
        }
        yield chunk
      }
    } finally { if (inherited !== undefined) inherited.released = true }
  })
  await applyLoopbackServerEffect(ctx, {
    label: 'governed-native-model-fixture',
    requestListener: (request, response) => {
      if (config.httpCounterFile !== undefined) {
        const count = Number(readFileSync(config.httpCounterFile, 'utf8'))
        writeFileSync(config.httpCounterFile, String(count + 1))
      }
      void (async () => {
        assert.equal(request.method, 'POST')
        assert.equal(request.url, sonar ? '/sonar/v1/chat/completions' : '/anthropic/v1/messages')
        assert.equal(request.headers[sonar ? 'authorization' : 'x-api-key'],
          sonar ? 'Bearer owned-native-fixture-key' : 'owned-native-fixture-key')
        const parts = []
        for await (const part of request) parts.push(part)
        const body = JSON.parse(Buffer.concat(parts).toString())
        const id = SessionId(request.headers['x-deepseek-harness-session-id'])
        const stored = await ctx.sessionPersistence.readFrom(id, SessionLogOffset(0))
        const recorded = stored.events.filter(event => event.type === requestEvent).at(-1)
        assert(recorded, 'The native model input must be stored before HTTP')
        assert.deepEqual(recorded.data.body, body)
        assert.equal(recorded.data.endpoint, `${endpoint}${sonar ? '/chat/completions' : '/v1/messages'}`)
        assert.equal(admissions.filter(admission => !admission.released).length, 1)
        persistedBeforeHttp = true
        nativeRequests += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(sonar ? { choices: [{ message: { content: 'Native result' } }], citations: ['https://result.test'],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        } : { usage: { input_tokens: 3, output_tokens: 2 }, content: [
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://result.test', title: 'Native result' }] },
        ] }))
      })().catch(error => { response.destroy(error) })
    },
    onListening: address => { endpoint = `http://127.0.0.1:${String(address.port)}/${sonar ? 'sonar/v1' : 'anthropic'}` },
    onCleanup: () => { assert(admissions.every(admission => admission.released), 'Every model permit must settle before shutdown') },
  })
  await ctx.credentials.set(credentialRef('NATIVE_FIXTURE_KEY'), 'owned-native-fixture-key')
  if (sonar) {
    await ctx.plugin(await import('@deepseek-ai/dsh-llm-pi-ai'), { providers: { 'sonar-owned': {
      api: 'openai-completions', baseURL: endpoint, apiKeyEnv: 'NATIVE_FIXTURE_KEY', models: [{ id: 'sonar', maxTokens: 64 }],
    } } })
  } else {
    await ctx.plugin(await import('@deepseek-ai/dsh-llm-deepseek-api-key'), { baseURL: endpoint, apiKeyEnv: 'NATIVE_FIXTURE_KEY' })
  }
  class Adapter extends LlmAdapter {
    async *stream(options) {
      if (calls++ % 2 === 0) {
        const id = ToolCallId('native-search'), name = 'web_search', args = '{"queries":["native fixture query"]}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      assert(options.messages.some(message => message.role === 'tool' && message.content.some(block =>
        block.type === 'text' && block.text.includes('https://result.test'))), 'The conversation must receive the real web-tool result')
      const text = 'NATIVE_SEARCH_DONE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['native-fixture'], new Adapter()))
  if (config.startupProcessFile !== undefined) {
    const subprocess = ctx.get('subprocess')
    assert(subprocess, 'The SDK profile must install its real subprocess provider')
    const program = `const fs=require('node:fs');if(process.env.DSH_SDK_PARENT_CONTROL!==undefined)throw Error('Private SDK capability leaked');fs.writeFileSync(${JSON.stringify(config.startupProcessFile)},String(process.pid))`
    const child = await subprocess.spawn({ argv: [process.execPath, '-e', program], cwd: process.cwd(),
      resourceOrigin: 'execution', graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    assert.deepEqual(await child.done, { exitCode: 0, signal: null })
    assert.equal(await child.waitForExit(), true)
    const pid = Number(readFileSync(config.startupProcessFile, 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    writeFileSync(config.startupProcessFile, JSON.stringify({ pid, closed: true }))
  }
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const completed = {
      modelAdmissions: admissions.length,
      executionAdmissions: admissions.filter(admission => admission.origin === 'execution').length,
      quiescent: admissions.filter(admission => admission.released).length,
      nativeRequests, persistedBeforeHttp, usages,
    }
    appendPluginRecord(agent.session, 'plugin:native-model-fixture/complete', completed)
    if (config.completionFile !== undefined) {
      const previous = JSON.parse(readFileSync(config.completionFile, 'utf8'))
      writeFileSync(config.completionFile, JSON.stringify({ ...previous, ranModel: true, native: completed }))
    }
  })
  ctx.provide('governedNativeModelReady', true)
}
