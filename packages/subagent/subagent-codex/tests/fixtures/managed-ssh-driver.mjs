/** Real Loader, standing SSH realm, native Codex and parent Responses admission. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'

const [configPath, mode] = process.argv.slice(2)
assert.ok(configPath && ['one-shot', 'member', 'revoked', 'quota', 'durability', 'nested', 'nested-revoked', 'retired'].includes(mode))
const nested = mode.startsWith('nested'), memberOwned = mode === 'member' || nested
const revoked = mode === 'revoked' || mode === 'nested-revoked', completedRun = mode === 'one-shot' || mode === 'nested' || mode === 'retired'
const nullResult = { parse(value) { assert.equal(value, null); return null } }
const root = process.cwd(), quote = value => `'${value.replaceAll("'", "'\\''")}'`
const bootEntry = process.env.DSH_SSH_CODEX_BOOT_ENTRY
assert.ok(bootEntry)
const helper = fileURLToPath(new URL('../../../../ssh/ssh/lib/helper.js', import.meta.url))
const carrier = fileURLToPath(new URL('../../../../ssh/ssh/tests/fixtures/local-ssh-carrier.mjs', import.meta.url))
const manifestPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(manifest.version, '0.153.4')
const native = resolve(dirname(manifestPath), manifest.bin.codex)
const bin = join(root, 'bin'), codexHome = join(root, 'codex-home')
await mkdir(bin); await mkdir(codexHome)
await writeFile(join(codexHome, 'config.toml'), 'check_for_update_on_startup = false\n[analytics]\nenabled = false\n[features]\napps = false\nplugins = false\nremote_plugin = false\nin_app_updates = false\n')
await writeFile(join(root, 'remote-codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(native)} "$@"\n`, { mode: 0o700 })
const sshCommand = process.env.DSH_NATIVE_SSH_FIXTURE_CONFIG === undefined
  ? `${quote(process.execPath)} ${quote(carrier)} ${quote(helper)}`
  : `/usr/bin/ssh -F ${quote(process.env.DSH_NATIVE_SSH_FIXTURE_CONFIG)}`
await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec ${sshCommand} "$@"\n`, { mode: 0o700 })
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
const actor = new AsyncLocalStorage()
const admissions = [], usages = [], upstream = [], ports = [], processes = [], failures = []
const queued = Promise.withResolvers(), grant = Promise.withResolvers()
const work = new Set()
let ctx, parent, child, connection, allowed = true, activeModels = 0, modelCalls = 0
const key = 'fixture-upstream-key-stays-in-parent'
const server = createServer((request, response) => {
  const task = (async () => {
    assert.equal(request.url, '/v1/responses')
    assert.equal(request.headers.authorization, `Bearer ${key}`)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(body.model, 'fixture-model')
    const owner = memberOwned ? child.agent : parent.agent
    const logged = owner.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request').at(-1)
    assert.deepEqual(logged.data.request.body, body)
    assert.equal(JSON.stringify(logged).includes(key), false)
    assert.equal(activeModels, 1)
    upstream.push(body)
    const commandTurn = upstream.length % 2 === 1
    const tool = commandTurn ? body.tools.find(tool => ['exec_command', 'shell_command'].includes(tool.name)) : undefined
    if (commandTurn) assert.ok(tool)
    const args = JSON.stringify(tool?.name === 'exec_command' ? { cmd: 'printf ssh-managed-child' } : { command: 'printf ssh-managed-child' })
    const item = commandTurn ? { type: 'function_call', id: `command_${upstream.length}`, call_id: `call_${upstream.length}`,
      name: tool.name, arguments: args, status: 'completed' }
      : { type: 'message', id: `answer_${upstream.length}`, status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'SSH_MANAGED_DONE', annotations: [] }] }
    const completed = { id: `response_${upstream.length}`, object: 'response', created_at: 1, model: body.model,
      status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
    const events = [
      { type: 'response.created', response: { ...completed, status: 'in_progress', output: [], usage: null } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress',
        ...commandTurn ? { arguments: '' } : { content: [] } } },
      ...commandTurn ? [
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: args },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args },
      ] : [
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'SSH_MANAGED_DONE' },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'SSH_MANAGED_DONE' },
        { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      ],
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: completed },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end('data: [DONE]\n\n')
  })().catch(error => { failures.push(error); response.destroy(error) })
  work.add(task)
  void task.finally(() => { work.delete(task) })
})
const notListening = port => new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); reject(new Error('Owned remote model listener is still open')) })
  socket.once('error', error => { if (error.code === 'ECONNREFUSED') resolve(); else reject(error) })
})
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const { boot, resolveConfigPath } = await import(bootEntry)
  ctx = await boot('managed-ssh-codex', resolveConfigPath(configPath, undefined))
  ctx.provide('modelAccessRequired', true)
  ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true } : { allowed: false, reason: 'Fixture permission revoked while queued' } })
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    const entry = { kind: request.kind, origin: request.origin, sessionId: String(request.sessionId), actor: actor.getStore(), settled: false }
    admissions.push(entry)
    if (request.kind === 'model') {
      modelCalls++
      assert.equal(activeModels, 0)
      if (modelCalls === 2 && (revoked || mode === 'quota')) {
        queued.resolve()
        await grant.promise
        if (mode === 'quota') throw new LlmError('Fixture model quota exhausted', 'RATE_LIMIT')
      }
      activeModels++
    }
    return { signal: new AbortController().signal, async release() {
      if (!entry.settled) { entry.settled = true; if (request.kind === 'model') activeModels-- }
    }, async uncertain() { throw new Error('Managed SSH fixture retained uncertain resources') } }
  } })
  await ctx.plugin(piAi, { providers: { 'parent-responses': { api: 'openai-responses',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture-model', maxTokens: 64 }],
    headers: { authorization: `Bearer ${key}` } } } })
  ctx.on('llm/delegated-stream', async function* (options, next) {
    for await (const chunk of next()) { if (chunk.type === 'usage') usages.push({ sessionId: String(options.sessionId), ...chunk.usage }); yield chunk }
  })
  const releasePreset = await ctx.agentPresets.register({ id: 'remote-fixture', plugins: [] })
  ctx.effect(() => releasePreset)
  ctx.effect(() => ctx.agentPresets.registerRealm('ssh:17', async scope => {
    const isolation = Object.create(scope[Context.isolate])
    for (const name of ['ssh', 'fs', 'subprocess']) isolation[name] = Symbol(name)
    scope[Context.isolate] = isolation
    const ssh = new SshConnection(scope, { host: 'fixture', helper, launch: { kind: 'node-script', node: process.execPath },
      helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'), workspace: root, requestTimeoutMs: 5000 })
    await ssh.ready
    new SshFileSystem(scope)
    new SshSubprocessRuntime(scope)
    connection = scope.get('ssh')
    const forward = connection.forwardLoopback.bind(connection)
    connection.forwardLoopback = async (...args) => { const result = await forward(...args); ports.push(result.port); return result }
    const subprocess = scope.get('subprocess'), spawn = subprocess.spawn.bind(subprocess)
    subprocess.spawn = async spec => {
      assert.equal(Object.hasOwn(spec.env ?? {}, 'OPENAI_API_KEY'), false)
      assert.equal(JSON.stringify(spec.env ?? {}).includes(key), false)
      assert.equal(typeof spec.env.DSH_CODEX_MODEL_TOKEN, 'string')
      const handle = await spawn(spec)
      processes.push(handle)
      return handle
    }
  }))
  const setup = async scope => { await ctx.agentPresets.mount(scope, 'remote-fixture', 'ssh:17') }
  parent = await ctx.agents.create({ sessionId: SessionId('ssh-model-parent'), meta: { cwd: root, sshTarget: 17 },
    agentOptions: { provider: 'parent-responses', model: 'fixture-model' }, setup })
  if (mode === 'durability') {
    const remove = ctx.on('session/flush', (session) => {
      if (session.snapshotEvents().some(event => event.type === 'subagent/codex-model-request')) {
        remove()
        throw new Error('Owned Session durability failed before model dispatch')
      }
    })
  }
  const provider = ctx.subagents.getProvider('codex')
  let outcome
  await actor.run('interactive-owner', async () => {
    if (nested) {
      const id = SessionId('ssh-model-member')
      await provider.prepareContinuable({ parent: parent.agent, sessionId: id, cwd: root, signal: new AbortController().signal })
      child = await ctx.agents.create({ sessionId: id, meta: { cwd: root, sshTarget: 17, parentSession: parent.agent.id },
        agentOptions: provider.agentRouteDefaults, setup })
      await ctx.sessions.flush(child.agent.session)
      await child.dispose()
      child = await ctx.agents.resume({ resumeSessionId: id, agentOptions: provider.agentRouteDefaults, setup })
      assert.equal(child.agent.options.provider, 'codex-member')
      assert.equal(child.agent.options.model, 'codex')
    }
    if (mode === 'member') {
      const id = SessionId('ssh-model-member')
      await provider.prepareContinuable({ parent: parent.agent, sessionId: id, cwd: root, signal: new AbortController().signal })
      child = await ctx.agents.create({ sessionId: id, meta: { cwd: root, sshTarget: 17, parentSession: parent.agent.id }, setup })
      const messages = []
      for (let turn = 0; turn < 2; turn++) {
        messages.push(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the fixture command and return the marker.' }] }))
        const chunks = []
        for await (const chunk of ctx.llm.stream({ ...provider.agentRouteDefaults, sessionId: id, messages })) chunks.push(chunk)
        assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'SSH_MANAGED_DONE')
        assert.equal(chunks.at(-1).reason.kind, 'stop')
        if (turn === 0) {
          await child.dispose()
          child = await ctx.agents.resume({ resumeSessionId: id, setup })
          assert.equal(child.agent.session.header.sshTarget, 17)
          assert.equal(child.agent.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request').length, 2)
        }
      }
      outcome = 'completed'
    } else {
      const run = await ctx.subagents.start('codex', { parent: nested ? child.agent : parent.agent, signal: new AbortController().signal,
        prompt: [{ type: 'text', text: 'Run the fixture command and return the marker.' }] })
      try {
        if (revoked || mode === 'quota') {
          await Promise.race([queued.promise, run.result.then(result => { throw new Error(`Native run finished before second request admission: ${JSON.stringify(result)}`) })])
          if (revoked) allowed = false
          grant.resolve()
        }
        const result = await run.result
        assert.equal(result.stopReason, completedRun ? 'completed' : 'error')
        if (completedRun) assert.deepEqual(result.output, [{ type: 'text', text: 'SSH_MANAGED_DONE' }])
        outcome = result.stopReason
      } finally { grant.resolve(); await run.dispose() }
    }
  })
  assert.equal(upstream.length, mode === 'member' ? 4 : completedRun ? 2 : mode === 'durability' ? 0 : 1)
  assert.equal(usages.length, upstream.length)
  assert.equal(activeModels, 0)
  const owner = memberOwned ? child.agent : parent.agent
  const modelAdmissions = admissions.filter(entry => entry.kind === 'model')
  assert(modelAdmissions.every(entry => entry.sessionId === String(owner.id) && entry.actor === 'interactive-owner'))
  assert(usages.every(entry => entry.sessionId === String(owner.id)))
  assert.equal(owner.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request').length, mode === 'quota' || revoked ? 2 : mode === 'durability' ? 1 : upstream.length)
  if (memberOwned) assert.equal(parent.agent.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request').length, 0)
  for (const process of processes) assert.equal(await process.waitForExit(), true)
  for (const port of ports) await notListening(port)
  await child?.dispose(); child = undefined
  if (mode === 'retired') {
    await releasePreset()
    assert.equal(await connection.request('heartbeat', {}, nullResult), null)
  }
  await parent.dispose(); parent = undefined
  if (mode === 'retired') await assert.rejects(connection.request('heartbeat', {}, nullResult), /SSH connection is closed/)
  await ctx.fiber.dispose()
  assert.equal(activeModels, 0)
  assert(admissions.every(entry => entry.settled || (mode === 'quota' && entry.kind === 'model' && entry === modelAdmissions.at(-1))))
  assert.equal(failures.length, 0, failures.map(error => error.stack).join('\n'))
  console.log(JSON.stringify({ mode, outcome, nativeRequests: upstream.length, modelAdmissions: modelAdmissions.length,
    usageOwners: [...new Set(usages.map(item => item.sessionId))], originalActor: modelAdmissions.length === 0 ? null : true, allPermitsSettled: true,
    upstreamKeyStayedInParent: true, nativeProcessesStopped: true, remoteModelListenersClosed: true, memberColdResume: memberOwned,
    ...mode === 'retired' ? { retiredRealmClosedBeforeHost: true } : {} }))
} finally {
  grant.resolve()
  try {
    const cleanupFailures = []
    for (const close of [() => child?.dispose(), () => parent?.dispose(), () => ctx?.fiber.dispose()]) {
      try { await close() } catch (error) { cleanupFailures.push(error) }
    }
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Managed SSH fixture cleanup failed')
  }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await Promise.allSettled([...work])
  }
}
