/** Bidirectional WebSocket terminal input channel: auth, revocation, framing, and HTTP fallback. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyConnection, inject as connectionInject, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { RemoteStream, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { streamMethod } from '@deepseek-ai/dsh-remote-mock'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessTerminalEnvironment, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalController, type Config, type TerminalCreatorId } from '../src/index.ts'
import { TERMINAL_INPUT_PATH } from '../src/input-protocol.ts'
import {
  TerminalInputChannelClosedError,
  TerminalInputChannelUnavailableError,
  type TerminalInputChannel,
} from '../src/client/input-channel.ts'
import { TerminalView, type TerminalRemote } from '../src/client/model.ts'
import type { TerminalAttachmentId, TerminalEnvironment, WebTerminalId, WebTerminalInfo } from '../src/types.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const config: Config = {
  shellCandidates: ['bash'],
  shell: { path: '/bin/bash', name: 'bash', args: ['-i'] },
  maxTerminals: 2,
  maxCols: 200,
  maxRows: 100,
  scrollback: 100,
  maxBufferedBytes: 100_000,
  maxInputBytes: 64,
  disposeGraceMs: 100,
  unattendedTimeoutMs: 7_200_000,
  activityPollIntervalMs: 30_000,
  cleanupRetryMs: 60_000,
}

async function createHostFixture(options: { managed?: boolean; verifyUpgradeCreator?: (creator: TerminalCreatorId) => boolean } = {}) {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(entry => entry.kind === 'exact' ? entry.path === pathname : pathname.startsWith(entry.path))
    if (route === undefined) { res.writeHead(404).end(); return }
    void Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500).end() })
  })
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = upgrades.find(entry => entry.path === pathname)
    if (route === undefined) { socket.destroy(); return }
    void Promise.resolve(route.handler(req, socket, head)).catch(() => { if (!socket.destroyed) socket.destroy() })
  })
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve) })
  const port = (httpServer.address() as AddressInfo).port
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await new Promise<void>((resolve) => { httpServer.close(() => { resolve() }) })
  })

  let credentialRecord: unknown
  ctx.provide('credentials', {
    readRecord: async () => credentialRecord,
    modifyRecord: async (_key: unknown, mutate: (current: unknown) => Promise<unknown>) => {
      const next = await mutate(credentialRecord)
      if (next !== undefined) credentialRecord = next
      return credentialRecord
    },
    deleteRecord: async () => { credentialRecord = undefined },
  } as never)
  ctx.provide('webServer', {
    host: '127.0.0.1',
    port,
    protocol: 'http:',
    register(route: WebRoute) {
      routes.push(route)
      return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) }
    },
    registerUpgrade(route: WebUpgradeRoute) {
      upgrades.push(route)
      return () => { const i = upgrades.indexOf(route); if (i >= 0) upgrades.splice(i, 1) }
    },
    tapIndex: () => () => {},
  } as unknown as WebServer)

  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection }).await()
  const connection = ctx.get('connection') as HostConnectionHandle

  provideWorkingDirectoryFixture(ctx, '/workspace')
  ctx.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    workspaceRoot: '/workspace',
    resolve: (): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' }),
  } as never)

  const output = new PassThrough()
  const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const writeSpy = vi.fn(async () => {})
  const resizeSpy = vi.fn(async () => {})
  const handle: SubprocessTerminalHandle = {
    pid: 456,
    output,
    done: done.promise,
    write: writeSpy,
    resize: resizeSpy,
    inspectActivity: vi.fn(async () => ({ state: 'unknown' as const, revision: 0 })),
    inspectForeground: async () => undefined,
    signalForeground: async () => 456,
    terminate: vi.fn(async () => { output.end(); done.resolve({ exitCode: 0, signal: null }) }),
  }
  ctx.provide('subprocess', {
    terminalEnvironment: vi.fn(async (): Promise<SubprocessTerminalEnvironment> => ({ platform: 'posix', defaultShell: '/bin/bash' })),
    resolveExecutable: vi.fn(async (path: string) => path),
    spawnTerminal: vi.fn(async () => handle),
  } as never)

  const revoked = new AbortController()
  if (options.managed) {
    ctx.provide('executionAuthorityRequired', true)
    ctx.provide('userTerminalAuthorization', {
      authorize: async () => ({
        creator: 'alice' as TerminalCreatorId,
        creatorUserId: 1,
        signal: revoked.signal,
        retain: () => ({ [Symbol.dispose]() {} }),
        [Symbol.dispose]() {},
      }),
      ...(options.verifyUpgradeCreator === undefined ? {} : { verifyUpgradeCreator: options.verifyUpgradeCreator }),
    })
  }

  const controller = new TerminalController(ctx, config)
  const agent = { id: 'session-1' as SessionId, ctx, session: { id: 'session-1' as SessionId, header: {} } } as unknown as Agent
  const token = new URL(connection.authenticatedUrl(`http://127.0.0.1:${port}`)).searchParams.get('token')!
  return { ctx, port, token, controller, agent, handle, writeSpy, resizeSpy, revoked }
}

async function openClientWs(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    const onOpen = (): void => { cleanup(); resolve(ws) }
    const onError = (): void => { cleanup(); reject(new Error('WebSocket handshake rejected')) }
    const cleanup = (): void => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })
}

async function sendAndReceive(ws: WebSocket, payload: unknown): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      cleanup()
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>)
    }
    const onClose = (event: CloseEvent): void => {
      cleanup()
      reject(new Error(`Socket closed before reply for ${JSON.stringify(payload)} (code=${String(event.code)}, reason=${event.reason})`))
    }
    const cleanup = (): void => {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
    }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.send(JSON.stringify(payload))
  })
}

describe('Host terminal input WebSocket channel', () => {
  it('delivers ordered write and resize frames over WebSocket and enforces limits', async () => {
    const h = await createHostFixture()
    const terminalId = 'term-ws-1' as WebTerminalId
    const attachmentId = 'att-ws-1' as TerminalAttachmentId
    await h.controller.create(h.agent, { id: terminalId, cols: 80, rows: 24 }, new AbortController().signal)

    const followAbort = new AbortController()
    const iterator = h.controller.follow(h.agent, terminalId, attachmentId, followAbort.signal)[Symbol.asyncIterator]()
    cleanups.push(async () => { followAbort.abort(); await iterator.return?.() })
    const first = await iterator.next()
    expect(first.value).toMatchObject({ type: 'snapshot' })

    const wsUrl = `ws://127.0.0.1:${h.port}${TERMINAL_INPUT_PATH}?sessionId=${h.agent.id}&terminalId=${terminalId}&attachmentId=${attachmentId}&token=${h.token}`
    const ws = await openClientWs(wsUrl)
    cleanups.push(() => { ws.close() })

    expect(await sendAndReceive(ws, { type: 'write', seq: 1, data: 'ls -la\r' })).toEqual({ type: 'ack', seq: 1 })
    expect(await sendAndReceive(ws, { type: 'resize', seq: 2, cols: 120, rows: 40 })).toEqual({ type: 'ack', seq: 2 })
    expect(h.writeSpy).toHaveBeenCalledWith('ls -la\r')
    expect(h.resizeSpy).toHaveBeenCalledWith(120, 40)

    // Oversized input returns an error frame without terminating the socket.
    const oversized = await sendAndReceive(ws, { type: 'write', seq: 3, data: 'x'.repeat(65) })
    expect(oversized).toMatchObject({ type: 'error', seq: 3 })
    expect(String(oversized.message)).toContain('limit')

    // Subsequent valid frames still succeed.
    expect(await sendAndReceive(ws, { type: 'write', seq: 4, data: 'ok' })).toEqual({ type: 'ack', seq: 4 })
  })

  it('refuses upgrades without a live attachment or matching managed creator and closes immediately on revocation', async () => {
    let allowCreator = false
    const h = await createHostFixture({
      managed: true,
      verifyUpgradeCreator: creator => allowCreator && creator === 'alice',
    })
    const terminalId = 'term-ws-auth' as WebTerminalId
    const attachmentId = 'att-ws-auth' as TerminalAttachmentId
    await h.controller.create(h.agent, { id: terminalId, cols: 80, rows: 24 }, new AbortController().signal)

    const wsUrl = `ws://127.0.0.1:${h.port}${TERMINAL_INPUT_PATH}?sessionId=${h.agent.id}&terminalId=${terminalId}&attachmentId=${attachmentId}&token=${h.token}`
    // No active follow() attachment -> rejected before upgrade.
    await expect(openClientWs(wsUrl)).rejects.toThrow()

    const followAbort = new AbortController()
    const iterator = h.controller.follow(h.agent, terminalId, attachmentId, followAbort.signal)[Symbol.asyncIterator]()
    cleanups.push(async () => { followAbort.abort(); await iterator.return?.() })
    await iterator.next()

    // Mismatched managed creator -> rejected before upgrade.
    await expect(openClientWs(wsUrl)).rejects.toThrow()

    // Matching managed creator -> accepted and immediately closed when authority revokes.
    allowCreator = true
    const ws = await openClientWs(wsUrl)
    cleanups.push(() => { ws.close() })
    expect(await sendAndReceive(ws, { type: 'write', seq: 1, data: 'hi' })).toEqual({ type: 'ack', seq: 1 })

    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => { resolve(event.code) }, { once: true })
    })
    h.revoked.abort(new Error('revoked'))
    await expect(closed).resolves.toBe(1008)
  })
})

describe('TerminalView input channel integration and HTTP fallback', () => {
  const sessionId = 'session' as SessionId
  const info: WebTerminalInfo = {
    id: 'terminal' as WebTerminalId,
    shell: { name: 'bash', path: '/bin/bash', args: ['-i'] },
    title: 'bash',
    cwd: '/workspace',
    rows: 24,
    cols: 80,
    state: 'running',
    exitCode: null,
  }
  const environment: TerminalEnvironment = { cwd: '/workspace', maxInputBytes: 1000, maxCols: 200, maxRows: 100, scrollback: 100 }
  const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })

  function clientFixture(factory: NonNullable<ConstructorParameters<typeof TerminalView>[8]>) {
    const remote: TerminalRemote = {
      retain: vi.fn<TerminalRemote['retain']>(streamMethod<TerminalRemote['retain']>(async function* (_s, _id, signal) {
        yield { type: 'retained' }
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      })),
      shells: vi.fn<TerminalRemote['shells']>(async () => ok([info.shell])),
      environment: vi.fn<TerminalRemote['environment']>(async () => ok(environment)),
      list: vi.fn<TerminalRemote['list']>(async () => ok([])),
      create: vi.fn<TerminalRemote['create']>(async (_s, req) => ok({ ...info, id: req.id })),
      close: vi.fn<TerminalRemote['close']>(async () => ok(undefined)),
      rename: vi.fn<TerminalRemote['rename']>(async () => ok(undefined)),
      write: vi.fn<TerminalRemote['write']>(async () => ok(undefined)),
      resize: vi.fn<TerminalRemote['resize']>(async () => ok(undefined)),
      follow: vi.fn<TerminalRemote['follow']>(streamMethod<TerminalRemote['follow']>(async function* (_s, id, attId, signal) {
        yield { type: 'snapshot', sequence: 0, screen: 'ready', info: { ...info, id, controllerId: attId } }
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      })),
    }
    const generation = createSnapshotStore<ReturnType<ConstructorParameters<typeof RemoteStream>[0]['generation']['getSnapshot']>>(undefined)
    const streams: RemoteStream<unknown>[] = []
    const gateway: Pick<ClientRemote, '$stream'> = {
      $stream: (option) => {
        const stream = new RemoteStream({ generation }, option)
        streams.push(stream)
        return stream
      },
    }
    cleanups.push(async () => { await Promise.all(streams.map(s => s.dispose())) })
    const model = new TerminalView(sessionId, remote, gateway, info.id, true, undefined, undefined, undefined, factory)
    cleanups.push(() => model.dispose())
    return { model, remote }
  }

  it('routes writes and resizes over an open input channel and transparently falls back to HTTP when unavailable', async () => {
    let open = true
    const writes: string[] = []
    const resizes: string[] = []
    const closeSpy = vi.fn()
    const channel: TerminalInputChannel = {
      get isOpen() { return open },
      write: vi.fn(async (data: string) => {
        if (!open) throw new TerminalInputChannelUnavailableError()
        writes.push(data)
      }),
      resize: vi.fn(async (cols: number, rows: number) => {
        if (!open) throw new TerminalInputChannelClosedError()
        resizes.push(`${cols}x${rows}`)
      }),
      close: closeSpy,
    }
    const factory = vi.fn(() => channel)
    const { model, remote } = clientFixture(factory)
    model.mount()
    await model.refresh()
    await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
    const render = model.state.getSnapshot().render
    if (render !== undefined) model.acknowledge(render.revision)

    expect(factory).toHaveBeenCalledOnce()
    model.write('hello')
    model.resize(100, 30)
    await expect.poll(() => resizes).toEqual(['100x30'])
    expect(writes).toEqual(['hello'])
    expect(remote.write).not.toHaveBeenCalled()
    expect(remote.resize).not.toHaveBeenCalled()

    // Simulate WS drop -> subsequent operations transparently fall back to HTTP RPCs.
    open = false
    model.write('fallback')
    model.resize(110, 35)
    await expect.poll(() => vi.mocked(remote.resize).mock.calls.length).toBe(1)
    expect(remote.write).toHaveBeenCalledWith(sessionId, info.id, expect.any(String), 'fallback')
    expect(remote.resize).toHaveBeenCalledWith(sessionId, info.id, expect.any(String), 110, 35)

    await model.dispose()
    expect(closeSpy).toHaveBeenCalled()
  })

  it('propagates RemoteError from the input channel identically to HTTP RPCs', async () => {
    const channel: TerminalInputChannel = {
      isOpen: true,
      write: vi.fn(async () => {
        throw new RemoteError('terminal/control-unavailable', 'read-only', { reason: 'read-only' })
      }),
      resize: vi.fn(async () => {}),
      close: vi.fn(),
    }
    const { model } = clientFixture(() => channel)
    model.mount()
    await model.refresh()
    await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
    model.write('blocked')
    await expect.poll(() => model.state.getSnapshot().writable).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ phase: 'connected', writable: false, error: undefined })
  })
})
