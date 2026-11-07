/** Actual Codex Responses delegation with persisted input and parent model ownership. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { applyLoopbackServerEffect } from '../../../../../snapshots/session/loopback-fixture-server.mjs'

export const inject = ['llm', 'tools', 'agents', 'subagents', 'subprocess', 'sessions', 'sessionPersistence', 'workingDirectory']

async function probeBodyDeadline(baseURL, token, signal) {
  const cancelled = new AbortController(), closed = Promise.withResolvers()
  const timer = setTimeout(() => { cancelled.abort(new Error('Body deadline probe did not finish.')) }, 5000)
  let outgoing
  try {
    return await new Promise((resolve, reject) => {
      outgoing = httpRequest(`${baseURL}/responses`, { method: 'POST', signal: AbortSignal.any([
        cancelled.signal, ...signal === undefined ? [] : [signal],
      ]), headers: { authorization: `Bearer ${token}`, 'content-length': '1000', expect: '100-continue', connection: 'close' } }, response => {
        void (async () => {
          const parts = []; for await (const part of response) parts.push(part)
          assert.equal(response.statusCode, 504)
          assert.equal(JSON.parse(Buffer.concat(parts).toString('utf8')).error.code, 'TIMEOUT')
          return response.statusCode
        })().then(resolve, reject)
      })
      outgoing.once('close', closed.resolve)
      outgoing.once('error', reject)
      outgoing.flushHeaders()
    })
  } finally {
    clearTimeout(timer)
    if (outgoing !== undefined) { outgoing.destroy(); await closed.promise }
  }
}

function eventsFor(body, turn) {
  const tool = body.tools.find(tool => tool.type === 'function' && ['exec_command', 'shell_command'].includes(tool.name))
  assert(tool, 'The pinned native Codex must advertise a command tool')
  const item = turn === 1 ? {
    id: 'fixture_command', type: 'function_call', status: 'completed', name: tool.name,
    call_id: 'managed_command', arguments: JSON.stringify(tool.name === 'exec_command'
      ? { cmd: 'echo managed-codex' } : { command: 'echo managed-codex' }),
  } : { id: 'fixture_answer', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: 'MANAGED_CODEX_DONE', annotations: [] }],
  }
  const response = { id: `managed_response_${turn}`, object: 'response', created_at: 1, model: body.model,
    status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: turn === 1 ? 5 : 1,
      input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: turn === 1 ? 15 : 11 },
  }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress',
      ...turn === 1 ? { arguments: '' } : { content: [] } } },
  ]
  if (turn === 1) events.push(
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
  )
  else events.push(
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'MANAGED_CODEX_DONE' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text: 'MANAGED_CODEX_DONE' },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: item.id, part: item.content[0] },
  )
  events.push(
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  )
  return events
}

/** Compose the production provider and actual native process against an owned Responses server. */
export async function apply(ctx, config = {}) {
  await applyFixture(ctx, config, {
    llm: await import('@deepseek-ai/dsh-llm'), session: await import('@deepseek-ai/dsh-session'),
    piAi: await import('@deepseek-ai/dsh-llm-pi-ai'), codex: await import('@deepseek-ai/dsh-subagent-codex'),
    tools: await import('@deepseek-ai/dsh-tools'),
  })
}

/** Bind every workspace module to the embedding test's source resolver. */
export function createManagedCodexFixture(services) {
  return { inject, apply: (ctx, config = {}) => applyFixture(ctx, config, services) }
}

async function applyFixture(ctx, config, services) {
  const { LlmAdapter, ToolCallId } = services.llm
  const { appendPluginRecord, SessionId, SessionLogOffset } = services.session
  const admissions = [], usage = [], failures = [], modelFailures = [], bodyTimeouts = []
  let baseURL, memberId, memberTurns = 0, baseMemberEvents = 0, requests = 0, persisted = 0, calls = 0
  if (!config.inheritParentAdmission) {
    ctx.provide('modelAccessRequired', true)
    ctx.provide('modelAccess', { decide: () => ({ allowed: true }) })
    ctx.provide('resourceBudgetRequired', true)
    ctx.provide('resourceBudget', { async acquire(request) {
      if (config.persistentMember && request.kind === 'model') {
        assert.equal(admissions.filter(item => item.kind === 'model' && !item.settled).length, 0,
          'An orchestration must not hold the only model slot while its native requests run')
      }
      const entry = { kind: request.kind, sessionId: String(request.sessionId), origin: request.origin, settled: false }
      admissions.push(entry)
      return { signal: new AbortController().signal, release: async () => { entry.settled = true },
        uncertain: async () => { throw Error('Managed Codex fixture retained an uncertain permit') },
      }
    } })
  }
  ctx.on('llm/delegated-stream', async function* (options, next) {
    assert.equal(options.provider, 'parent-responses')
    assert.equal(options.resourceOrigin, 'execution')
    for await (const chunk of next()) {
      if (chunk.type === 'usage') usage.push(chunk.usage)
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) modelFailures.push(chunk.reason)
      yield chunk
    }
  })
  await applyLoopbackServerEffect(ctx, {
    label: 'managed-codex-responses',
    onListening: address => { baseURL = `http://127.0.0.1:${address.port}/v1` },
    requestListener: (request, response) => {
      void (async () => {
        assert.equal(request.url, '/v1/responses')
        assert.equal(request.headers.authorization, 'Bearer parent-owned-codex-fixture-key')
        const parts = []
        for await (const part of request) parts.push(part)
        const body = JSON.parse(Buffer.concat(parts).toString())
        const sessionId = SessionId(request.headers['x-deepseek-harness-session-id'])
        const stored = await ctx.sessionPersistence.readFrom(sessionId, SessionLogOffset(0))
        const event = stored.events.filter(event => event.type === 'subagent/codex-model-request').at(-1)
        assert.deepEqual(event?.data.request.body, body, 'The exact native request must be durable before HTTP')
        persisted++
        if (!config.inheritParentAdmission) assert.equal(admissions.filter(item => item.kind === 'model' && !item.settled).length, 1)
        requests++
        if (config.httpCounterFile !== undefined) writeFileSync(config.httpCounterFile, String(requests))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of eventsFor(body, requests % 2 === 1 ? 1 : 2)) response.write(`data: ${JSON.stringify(event)}\n\n`)
        response.end('data: [DONE]\n\n')
      })().catch(error => { failures.push(error); response.destroy(error) })
    },
    onCleanup: () => {
      assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'))
      assert(admissions.every(item => item.settled), 'Every parent permit must settle')
    },
  })
  await ctx.plugin(services.piAi, { providers: { 'parent-responses': {
    api: 'openai-responses', baseURL, models: [{ id: 'codex-fixture', maxTokens: 64 }],
    headers: { authorization: 'Bearer parent-owned-codex-fixture-key' },
  } } })
  const home = join(ctx.workingDirectory.defaultDirectory, '.managed-codex-home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'config.toml'), 'check_for_update_on_startup = false\n[analytics]\nenabled = false\n[features]\napps = false\nplugins = false\nremote_plugin = false\nin_app_updates = false\n')
  if (config.probeModelBodyDeadline) {
    const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-subagent-codex/package.json'))
    const { symbols } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
    const runtime = ctx.subprocess[symbols.original]
    assert(runtime, 'The fixture needs the actual subprocess service owner')
    ctx.effect(() => {
      const descriptor = Object.getOwnPropertyDescriptor(runtime, 'spawn'), original = runtime.spawn
      runtime.spawn = async function (spec) {
        const setting = spec.argv.find(value => value.startsWith('model_providers.dsh_parent.base_url='))
        const token = spec.env?.DSH_CODEX_MODEL_TOKEN
        if (setting !== undefined && token !== undefined) {
          const before = admissions.length
          const status = await probeBodyDeadline(JSON.parse(setting.slice(setting.indexOf('=') + 1)), token, spec.signal)
          assert.equal(admissions.length, before, 'An incomplete body must not acquire model capacity')
          bodyTimeouts.push(status)
        }
        return Reflect.apply(original, this, [spec])
      }
      return () => {
        if (descriptor === undefined) delete runtime.spawn
        else Object.defineProperty(runtime, 'spawn', descriptor)
      }
    })
  }
  await ctx.plugin(services.codex, {
    providerName: 'owned-codex', modelProvider: 'parent-responses', model: 'codex-fixture', permissionMode: 'never',
    stateDir: join(home, 'external-bindings'),
    ...config.probeModelBodyDeadline ? { modelRequestTimeoutMs: 1000 } : {},
    env: { HOME: home, USERPROFILE: home, CODEX_HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' },
  })
  if (config.persistentMember) {
    const { defineContentToolFixture } = services.tools
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'managed_codex', description: 'Run two turns in one managed persistent member.',
      parameters: { description: { type: 'string' }, prompt: { type: 'string' } },
      async execute(args, exec) {
        const parent = exec.agent
        assert(parent, 'A real calling Agent owns the continuable member')
        const started = await ctx.subagents.startContinuable({ provider: 'owned-codex', label: args.description,
          request: { parent, prompt: [{ type: 'text', text: args.prompt }] }, signal: exec.signal })
        memberId = started.childId
        await ctx.subagents.waitForChildren(parent)
        assert.equal(ctx.agents.get(memberId), undefined, 'The first Activation must settle before cold resume')
        memberTurns++
        await ctx.subagents.sendMessage(parent, memberId,
          [{ type: 'text', text: 'Run the fixture command again and return the final marker.' }], { signal: exec.signal })
        await ctx.subagents.waitForChildren(parent)
        assert.equal(ctx.agents.get(memberId), undefined, 'The resumed Activation must settle')
        memberTurns++
        const persistedChild = await ctx.sessionPersistence.readFrom(memberId, SessionLogOffset(0))
        baseMemberEvents = persistedChild.events.filter(event => event.type === 'subagent/codex-model-request').length
        assert.equal(baseMemberEvents, 4)
        assert(admissions.filter(item => item.sessionId === String(memberId)).every(item => item.origin === 'execution'))
        return [{ type: 'text', text: 'MANAGED_CODEX_DONE' }]
      },
    })))
  }
  class Conversation extends LlmAdapter {
    async *stream(options) {
      if (calls++ % 2 === 0) {
        const id = ToolCallId('managed-codex-call'), name = 'managed_codex'
        const args = JSON.stringify({ description: 'Verify parent model admission', prompt: 'Update the fixture plan and return the final marker.' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      assert(options.messages.some(message => message.role === 'tool' && message.content.some(block =>
        block.type === 'text' && block.text.includes('MANAGED_CODEX_DONE'))),
      JSON.stringify({ nativeRequests: requests, persisted, modelFailures, serverFailures: failures.map(error => error.message),
        toolResults: options.messages.filter(message => message.role === 'tool').map(message => message.content) }))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PARENT_CODEX_DONE' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['codex-conversation-fixture'], new Conversation())
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (config.persistentMember && agent.options.provider !== 'codex-conversation-fixture') return
    const result = { nativeRequests: requests, persistedBeforeHttp: persisted,
      usage, modelPermits: admissions.filter(item => item.kind === 'model').length,
      processPermits: admissions.filter(item => item.kind === 'process').length,
      allPermitsSettled: admissions.every(item => item.settled),
      allOwnersMatch: admissions.every(item => item.sessionId === String(agent.id)
        || config.persistentMember && item.sessionId === String(memberId)),
      ...config.probeModelBodyDeadline ? { bodyTimeouts } : {},
      ...config.persistentMember ? { memberTurns, memberRequests: baseMemberEvents,
        memberModelPermits: admissions.filter(item => item.kind === 'model' && item.sessionId === String(memberId)).length,
        parentNativeRequests: agent.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request').length } : {},
    }
    appendPluginRecord(agent.session, 'plugin:managed-codex-fixture/complete', result)
    if (config.completionFile !== undefined) writeFileSync(config.completionFile, JSON.stringify(result))
  })
  ctx.provide('managedCodexModelReady', true)
}
