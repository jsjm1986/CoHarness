/** Remote proxies: namespace discovery from roster injects and mock rules, and per-call routing over the Connection to the mock. */
import { RemoteMock, frames, ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ClientPluginModule } from '../src/assembly/index.ts'
import { TestClient, remoteDefaultResponses, webApp } from '../src/assembly/index.ts'
import { remoteNamespacesOf } from '../src/assembly/remote-proxies.ts'

/** The client-runtime row and its cone: Gateway, Typert, Connection, and the api-remotes row TestClient drops. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-client-runtime'])

type RemoteFace = Record<string, Record<string, (...args: unknown[]) => unknown>>

async function drain(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of source) items.push(item)
  return items
}

describe('remoteNamespacesOf', () => {
  it('collects remote.<ns> injects in both inject forms plus the namespaces of registered endpoints, skipping Gateway-internal ones', () => {
    const modules: ClientPluginModule[] = [
      { apply() {}, inject: ['slots', 'remote.settings', 'remote'] },
      { apply() {}, inject: { 'remote.goals': { required: true }, connection: { required: false } } },
      { apply() {} },
    ]
    const mock = RemoteMock.create().unary('commands/list', ok([])).stream('workspace/follow', openStream())
    expect(remoteNamespacesOf(modules, mock)).toEqual(['commands', 'goals', 'settings', 'workspace'])
  })
})

describe('remote proxies over a booted client', () => {
  it('boots the Remote subset from source and answers a namespace no generated contribution declares', async () => {
    const name = '@deepseek-ai/dsh-api-remotes'
    const mock = RemoteMock.create().load(remoteDefaultResponses).unary('synthetic/search', ok({ hits: 2 }))
    const client = await TestClient.start({ roster: API_ROSTER }, mock)
    onTestFinished(() => client.dispose())
    expect([...client.ctx.loader.entries()].map(entry => entry.options.name)).not.toContain(name)
    const remote = (client.ctx as unknown as { remote: RemoteFace }).remote
    await expect(remote.synthetic!.search!({ query: 'docs' })).resolves.toEqual(ok({ hits: 2 }))
    expect(mock.log.calls('synthetic/search').map(call => call.args)).toEqual([[{ query: 'docs' }]])
  })

  async function booted(configure: (mock: RemoteMock) => void = () => {}) {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    configure(mock)
    const client = await TestClient.start({ roster: API_ROSTER }, mock)
    onTestFinished(() => client.dispose())
    return { client, mock, remote: (client.ctx as unknown as { remote: RemoteFace }).remote }
  }

  it('drops the api-remotes row and answers ctx.remote.<ns>.<method> with the mock value, logging positional args', async () => {
    const { client, mock, remote } = await booted((m) => {
      m.unary('commands/execute', ok({ output: 'done', code: 0 }))
      m.unary('commands/cancel', { ok: false, error: { code: 'commands/not-found', message: 'gone', details: {} } })
    })
    expect([...client.ctx.loader.entries()].map(entry => entry.options.name)).not.toContain('@deepseek-ai/dsh-api-remotes')
    await expect(remote.commands!.execute!({ sessionId: 's1', name: 'status' })).resolves.toEqual({ ok: true, value: { output: 'done', code: 0 } })
    // Wire failures rebuild as RemoteError instances, not plain objects.
    await expect(remote.commands!.cancel!({ sessionId: 's1' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'commands/not-found', message: 'gone', details: {} } })
    expect(mock.log.calls('commands/execute').map(call => call.args)).toEqual([[{ sessionId: 's1', name: 'status' }]])
    expect(mock.log.calls('commands/cancel').map(call => call.args)).toEqual([[{ sessionId: 's1' }]])
    expect((remote.commands as unknown as { then?: unknown }).then).toBeUndefined()
    expect((remote.commands as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined()
  }, 60_000)

  it('folds a call without a rule into gateway/internal and leaves the miss in the log for dispose() to report', async () => {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: API_ROSTER }, mock)
    const remote = (client.ctx as unknown as { remote: RemoteFace }).remote
    await expect(remote.commands!.search!({ query: 'x' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/internal', message: expect.stringMatching(/^client api: commands\/search failed: remote-mock: no rule for commands\/search; registered: /) as string },
    })
    expect(mock.log.unmatched()).toEqual([{ endpoint: 'commands/search', mode: 'unary' }])
    await expect(client.dispose()).rejects.toThrow('commands/search (unary)')
  })

  it('folds a rule rejection like the generated client: gateway/internal, or gateway/cancelled once the signal aborted', async () => {
    const { mock, remote } = await booted((m) => {
      m.unary('commands/execute', () => Promise.reject(new Error('wire down')))
      m.unary('commands/cancel', () => new Promise(() => {}))
    })
    await expect(remote.commands!.execute!({ sessionId: 's1', name: 'status' })).resolves.toMatchObject({
      ok: false, error: { code: 'gateway/internal', message: 'client api: commands/execute failed: wire down' },
    })
    const controller = new AbortController()
    const cancelling = remote.commands!.cancel!({ sessionId: 's1' }, controller.signal) as Promise<unknown>
    controller.abort()
    await expect(cancelling).resolves.toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    expect(mock.log.calls('commands/execute').map(call => call.state)).toEqual(['failed'])
    expect(mock.log.calls('commands/cancel').map(call => call.state)).toEqual(['pending'])
  })

  it('opens registered streams and hands their items and failures through unchanged', async () => {
    const { remote } = await booted((m) => {
      m.stream('goals/follow', frames([{ type: 'a' }, { type: 'b' }]))
      m.stream('goals/control', ((_args, stream) => { stream.fail(new Error('flap')) }))
    })
    const signal = new AbortController().signal
    await expect(drain(remote.goals!.follow!({ goalId: 'g1' }, signal) as AsyncIterable<unknown>))
      .resolves.toEqual([{ type: 'a' }, { type: 'b' }])
    await expect(drain(remote.goals!.control!({}) as AsyncIterable<unknown>)).rejects.toThrow('flap')
  })
})
