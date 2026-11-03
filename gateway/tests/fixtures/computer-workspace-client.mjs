/** Browser object services creating Workspace-owned conversations through two real Gateways. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AbstractApiClient } from '../../../packages/host/apiproxy/lib/types/fetch/client.js'
import { SessionRuntime } from '../../../packages/client/runtime/lib/types/client/sessions/service.js'
import { SessionRuntimePool } from '../../../packages/client/runtime/lib/types/client/sessions/pool.js'
import { WorkspaceRuntime } from '../../../packages/client/runtime/lib/types/client/workspaces/service.js'
import { createSnapshotStore } from '../../../packages/client/runtime/lib/types/client/contract/store.js'
import { clientSessionKey, parseClientSessionKey } from '../../../packages/host/apiproxy/lib/types/api/client-session.js'
import { observeInputDraftSessions } from '../../../packages/client/ui-workspace/lib/types/client/draft-sessions.js'
import { CommandDirectory } from '../../../packages/client/ui-commands/lib/types/client/directory.js'
import { verifyCapturedRemote } from './captured-remote-client.mjs'

class GatewayClient extends AbstractApiClient {
  constructor(base, cookie, target) {
    super(30000, 16 * 1024 * 1024, { kind: 'personal' }, 'none')
    this.base = base; this.cookie = cookie; this.target = target
  }
  resolveBase() { return this.base }
  resolveUrl(path) { const url = super.resolveUrl(path); url.searchParams.set('dshRuntime', this.target.runtimeId); return url }
  doFetch(input, init) {
    const headers = new Headers(init.headers)
    headers.set('cookie', this.cookie); headers.set('origin', this.base)
    return fetch(input, { ...init, headers })
  }
}

function value(response) {
  assert.equal(response.result.ok, true, JSON.stringify(response.result))
  return response.result.value
}

/** Keep the replacement history response pending while a real first open is superseded. */
async function verifyReplacedHistory(base, cookie, target, workspaceId, remote) {
  const first = Promise.withResolvers(), replacement = Promise.withResolvers()
  const releaseFirst = Promise.withResolvers(), releaseReplacement = Promise.withResolvers()
  let historyReads = 0
  class ControlledHistoryClient extends GatewayClient {
    async doFetch(input, init) {
      const response = await super.doFetch(input, init)
      if (input.pathname === '/api/session.history') {
        const round = ++historyReads
        if (round === 1) { first.resolve(); await releaseFirst.promise }
        else if (round === 2) { replacement.resolve(); await releaseReplacement.promise }
      }
      return response
    }
  }
  const api = new ControlledHistoryClient(base, cookie, target)
  const owner = new Context()
  await owner.plugin(() => {}).await()
  const within = (promise, label) => {
    let timer
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not reach its response barrier`)), 20000)
    })]).finally(() => clearTimeout(timer))
  }
  let reference
  try {
    const runtime = new SessionRuntime(owner, api, remote, undefined, { provideService: false, persistSelection: false })
    const id = await runtime.create({ workspaceId })
    reference = runtime.retain(id, { source: 'composer' })
    // Observe rejection immediately; the final assertion still receives its original cause.
    void reference.ready.catch(() => {})
    const originalOpening = reference.binding.session.open()
    await within(first.promise, 'Initial history')
    runtime.handleConnected()
    await within(replacement.promise, 'Replacement history')
    releaseFirst.resolve()
    await originalOpening
    assert.equal(reference.binding.session.getSnapshot().openState, 'loading')
    value(await api.host.describe({}))
    releaseReplacement.resolve()
    const ready = await reference.ready
    assert.equal(ready.session.getSnapshot().openState, 'open')
    assert.equal(historyReads, 2)
  } finally {
    releaseFirst.resolve(); releaseReplacement.resolve()
    reference?.release()
    await owner.fiber.dispose()
  }
}

/** Run the production computer-create operation with real wire and durable Workspace membership. */
export async function computerWorkspaceClient(base, cookie, primary, secondary) {
  const a = new GatewayClient(base, cookie, primary), b = new GatewayClient(base, cookie, secondary)
  const handles = new Map()
  for (const [target, api] of [[primary, a], [secondary, b]]) {
    const description = value(await api.host.describe({}))
    assert.equal(description.runtimeTarget.runtimeId, target.runtimeId)
    const hostDescription = createSnapshotStore(description)
    handles.set(target.runtimeId, { api, isLoopback: false, interactions: 'none', hostDescription,
      metadataTiming: { requestTimeoutMs: 30000, retryAfterMs: 10000 },
      start(sinks) {
        let stopped = false
        void api.host.describe({}).then(response => { if (!stopped) sinks.onConnected?.(value(response)) })
        return { stop() { stopped = true } }
      } })
  }
  const connection = { ...handles.get(primary.runtimeId), forTarget: target => handles.get(target.runtimeId) }
  const ctx = new Context()
  await ctx.plugin(() => {}).await()
  ctx.provide('connection', connection)
  // No message is sent. Optional Remote catalogs are outside Workspace creation.
  const remote = { commands: { list: async () => ({ ok: true, value: [] }) }, subagents: {
    list: async () => ({ ok: true, value: { entries: [], parentAvailable: false } }),
  } }
  const local = new SessionRuntime(ctx, a, remote, undefined, { provideService: false, persistSelection: false })
  const sessions = new SessionRuntimePool(ctx, local, connection, remote)
  sessions.setBaseRuntimeTarget(primary)
  sessions.installPersonalDirectory([], true)
  const workspaces = new WorkspaceRuntime(ctx, a, sessions)
  workspaces.installPersonalDirectory([{ runtime: secondary, status: 'active', observedState: 'ready', syncedAt: null, items: [] }], primary.runtimeId)
  try {
    const create = async workspaceId => sessions.usingRuntime(secondary, new AbortController().signal, async signal => {
      const id = await workspaces.createRuntimeSession(secondary, workspaceId, signal)
      assert.equal(parseClientSessionKey(id).runtime.runtimeId, secondary.runtimeId)
      sessions.open(id)
      return parseClientSessionKey(id).sessionId
    })
    const first = await create()
    const registered = value(await b.workspace.list({})).items.find(item => item.sessionIds.includes(first))
    assert.equal(registered.path, handles.get(secondary.runtimeId).hostDescription.getSnapshot().cwd)
    const projected = workspaces.list.getSnapshot().items.find(item => item.path === registered.path)
    assert.ok(projected)
    let second
    const inputs = createSnapshotStore([])
    const stopInputs = observeInputDraftSessions(sessions, ids => inputs.set(ids))
    const firstId = clientSessionKey(secondary, first)
    const composer = sessions.retain(firstId, { source: 'composer' })
    try {
      try {
        await composer.ready
        second = await create(projected.workspaceId)
        assert.notEqual(first, second)
        const fresh = value(await b.workspace.list({})).items.find(item => item.workspaceId === registered.workspaceId)
        assert.ok(fresh.sessionIds.includes(first)); assert.ok(fresh.sessionIds.includes(second))
        assert.ok(inputs.getSnapshot().includes(firstId))
        assert.notEqual(sessions.list.getSnapshot().current, firstId)
      } finally { composer.release() }
      assert.equal(inputs.getSnapshot().includes(firstId), false)
    } finally { stopInputs() }
    await assert.rejects(workspaces.createRuntimeSession(primary, projected.workspaceId), /another Runtime/u)
    const primaryRows = value(await a.sessions.list({})).items
    assert.equal(primaryRows.some(item => item.sessionId === first || item.sessionId === second), false)
    await verifyCapturedRemote(base, cookie, connection, primary, secondary, first)

    const arrived = Promise.withResolvers(), release = Promise.withResolvers()
    let pulls = 0, active = 0, peak = 0
    const directory = new CommandDirectory(async sessionId => {
      const round = ++pulls
      peak = Math.max(peak, ++active)
      try {
        const url = new URL('/api/commands/list', base)
        url.searchParams.set('dshRuntime', secondary.runtimeId)
        const response = await fetch(url, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'commands/list', payload: { args: { agentId: sessionId } } }) })
        assert.equal(response.status, 200)
        const commands = value(await response.json())
        assert.ok(commands.length > 0)
        if (round === 1) { arrived.resolve(); await release.promise }
        return commands
      } finally { active-- }
    })
    const catalog = directory.refresh(first)
    await Promise.race([arrived.promise, catalog.then(() => { throw new Error('Initial catalog must reach the response barrier') })])
    try {
      for (let i = 0; i < 40; i++) { directory.invalidateAll(); directory.resetConnected() }
      assert.equal(pulls, 1)
    } finally { release.resolve() }
    await catalog
    assert.equal(pulls, 2)
    assert.equal(peak, 1)
    assert.equal(directory.status(first), 'ready')
    await verifyReplacedHistory(base, cookie, secondary, registered.workspaceId, remote)
  } finally { await ctx.fiber.dispose() }
}
