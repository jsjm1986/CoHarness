/** Bidirectional WebSocket terminal input channel: authorization, revocation, and framing. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyConnection, inject as connectionInject, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessTerminalEnvironment, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalController, type Config, type TerminalCreatorId } from '../src/index.ts'
import { TERMINAL_INPUT_PATH } from '../src/input-protocol.ts'
import {
  bindTerminalInputSocket,
  parseTerminalInputQuery,
  resolveAuthorizedTerminalAttachment,
  type ActiveTerminalAttachment,
  type TerminalInputSocket,
} from '../src/input-channel.ts'
import type { TerminalAttachmentId, WebTerminalId } from '../src/types.ts'

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

function fixtureAgent(ctx: Context, id: SessionId): Agent {
  return { id, ctx, session: { id, header: {} } as Agent['session'] } as Agent
}

async function createHostFixture(options: { managed?: boolean; verifyUpgradeCreator?: (creator: TerminalCreatorId) => boolean } = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }).await()
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('The terminal fixture HTTP server did not bind')

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
  const agent = fixtureAgent(ctx, 'session-1' as SessionId)
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

  it('closes active input sockets on controller disposal and refuses late upgrades when attachment disappears mid-handshake', async () => {
    const h = await createHostFixture()
    const terminalId = 'term-ws-dispose' as WebTerminalId
    const attachmentId = 'att-ws-dispose' as TerminalAttachmentId
    // Use an independent agent context so disposing the controller closes live sockets with 1001 before owner teardown.
    const agentCtx = new Context()
    cleanups.push(() => agentCtx.fiber.dispose())
    agentCtx.provide('subprocess', h.ctx.get('subprocess') as never)
    agentCtx.provide('sandboxPolicy', h.ctx.get('sandboxPolicy') as never)
    const detachedAgent = fixtureAgent(agentCtx, 'session-dispose' as SessionId)
    await h.controller.create(detachedAgent, { id: terminalId, cols: 80, rows: 24 }, new AbortController().signal)

    const followAbort = new AbortController()
    const iterator = h.controller.follow(detachedAgent, terminalId, attachmentId, followAbort.signal)[Symbol.asyncIterator]()
    cleanups.push(async () => { followAbort.abort(); await iterator.return?.() })
    await iterator.next()

    const wsUrl = `ws://127.0.0.1:${h.port}${TERMINAL_INPUT_PATH}?sessionId=${detachedAgent.id}&terminalId=${terminalId}&attachmentId=${attachmentId}&token=${h.token}`
    const ws = await openClientWs(wsUrl)
    cleanups.push(() => { ws.close() })
    const disposedClose = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => { resolve(event.code) }, { once: true })
    })
    await h.ctx.fiber.dispose()
    expect([1001, 1006]).toContain(await disposedClose)

    // Attachment disappears between authorize() and handler callback -> handler closes socket with 1008.
    let checks = 0
    const h2 = await createHostFixture({
      managed: true,
      verifyUpgradeCreator: () => ++checks === 1,
    })
    await h2.controller.create(h2.agent, { id: terminalId, cols: 80, rows: 24 }, new AbortController().signal)
    const followAbort2 = new AbortController()
    const it2 = h2.controller.follow(h2.agent, terminalId, attachmentId, followAbort2.signal)[Symbol.asyncIterator]()
    cleanups.push(async () => { followAbort2.abort(); await it2.return?.() })
    await it2.next()
    const wsUrl2 = `ws://127.0.0.1:${h2.port}${TERMINAL_INPUT_PATH}?sessionId=${h2.agent.id}&terminalId=${terminalId}&attachmentId=${attachmentId}&token=${h2.token}`
    const raceWs = new WebSocket(wsUrl2)
    cleanups.push(() => { raceWs.close() })
    const raceCode = await new Promise<number>((resolve) => {
      raceWs.addEventListener('close', (event) => { resolve(event.code) }, { once: true })
    })
    expect(raceCode).toBe(1008)
  })
})

describe('Host input-channel unit edge cases', () => {
  function makeMockSocket() {
    const ac = new AbortController()
    let state: 'open' | 'closing' | 'closed' = 'open'
    const messageListeners = new Set<(frame: string) => void>()
    const closeListeners = new Set<() => void>()
    const sent: string[] = []
    const closes: Array<{ code?: number; reason?: string }> = []
    const socket: TerminalInputSocket = {
      signal: ac.signal,
      get readyState() { return state },
      send(frame: string) { sent.push(frame) },
      close(code?: number, reason?: string) {
        closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
        state = 'closed'
        ac.abort()
        for (const fn of [...closeListeners]) fn()
      },
      onMessage(fn) {
        messageListeners.add(fn)
        return () => { messageListeners.delete(fn) }
      },
      onClose(fn) {
        closeListeners.add(fn)
        return () => { closeListeners.delete(fn) }
      },
    }
    return {
      socket,
      sent,
      closes,
      setState(next: 'open' | 'closing' | 'closed') { state = next },
      emitMessage(raw: string) { for (const fn of [...messageListeners]) fn(raw) },
    }
  }

  function makeAttachment(overrides: Partial<ActiveTerminalAttachment> = {}): {
    attachment: ActiveTerminalAttachment
    abort: AbortController
    writeSpy: ReturnType<typeof vi.fn<() => Promise<void>>>
    resizeSpy: ReturnType<typeof vi.fn<() => Promise<void>>>
  } {
    const abort = new AbortController()
    const writeSpy = vi.fn<() => Promise<void>>(async () => {})
    const resizeSpy = vi.fn<() => Promise<void>>(async () => {})
    const attachment: ActiveTerminalAttachment = {
      key: 'k',
      sessionId: 's1' as SessionId,
      terminalId: 't1' as WebTerminalId,
      attachmentId: 'a1' as TerminalAttachmentId,
      creator: 'alice' as TerminalCreatorId,
      terminal: { write: writeSpy, resize: resizeSpy } as never,
      signal: abort.signal,
      isClosed: () => false,
      ...overrides,
    }
    return { attachment, abort, writeSpy, resizeSpy }
  }

  it('validates query strings and authorized attachment resolution', () => {
    expect(parseTerminalInputQuery(undefined)).toBeUndefined()
    expect(parseTerminalInputQuery('http://[::1')).toBeUndefined()
    expect(parseTerminalInputQuery('/api/terminal/input?sessionId=&terminalId=t1&attachmentId=a1')).toBeUndefined()
    expect(parseTerminalInputQuery('/api/terminal/input?sessionId=s1&terminalId=bad!&attachmentId=a1')).toBeUndefined()
    expect(parseTerminalInputQuery('/api/terminal/input?sessionId=s1&terminalId=t1&attachmentId=a1')).toEqual({
      sessionId: 's1',
      terminalId: 't1',
      attachmentId: 'a1',
    })

    const { attachment } = makeAttachment()
    expect(resolveAuthorizedTerminalAttachment({ url: '/invalid' } as never, () => attachment, () => true)).toBeUndefined()
    expect(resolveAuthorizedTerminalAttachment(
      { url: '/api/terminal/input?sessionId=s1&terminalId=t1&attachmentId=a1' } as never,
      () => undefined,
      () => true,
    )).toBeUndefined()
    expect(resolveAuthorizedTerminalAttachment(
      { url: '/api/terminal/input?sessionId=s1&terminalId=t1&attachmentId=a1' } as never,
      () => ({ ...attachment, isClosed: () => true }),
      () => true,
    )).toBeUndefined()
    expect(resolveAuthorizedTerminalAttachment(
      { url: '/api/terminal/input?sessionId=s1&terminalId=t1&attachmentId=a1' } as never,
      () => attachment,
      () => false,
    )).toBeUndefined()
  })

  it('handles aborted-on-entry, socket replacement, malformed frames, RemoteError, non-Error throws, and mid-flight endings', async () => {
    const controller = new AbortController()

    const defaultLimits = { maxInputBytes: 64, validateDimensions: () => {} }
    // Already closed on entry.
    const closedEntry = makeMockSocket()
    const closedAtt = makeAttachment({ isClosed: () => true })
    await bindTerminalInputSocket(closedEntry.socket, closedAtt.attachment, defaultLimits, controller.signal)
    expect(closedEntry.closes).toEqual([{ code: 1008, reason: 'terminal unavailable' }])

    // Replace existing inputSocket with a new one.
    const first = makeMockSocket()
    const second = makeMockSocket()
    const live = makeAttachment()
    await bindTerminalInputSocket(first.socket, live.attachment, { maxInputBytes: 64, validateDimensions: () => {} }, controller.signal)
    await bindTerminalInputSocket(second.socket, live.attachment, { maxInputBytes: 64, validateDimensions: () => {} }, controller.signal)
    expect(first.closes).toEqual([{ code: 1000, reason: 'replaced' }])
    expect(live.attachment.inputSocket).toBe(second.socket)

    // RemoteError and non-Error serialization, plus sendFrame when socket not open.
    live.writeSpy.mockRejectedValueOnce(new RemoteError('terminal/control-unavailable', 'denied', { reason: 'read-only' }))
    live.writeSpy.mockRejectedValueOnce('raw-string-error')
    second.emitMessage(JSON.stringify({ type: 'write', seq: 1, data: 'a' }))
    second.emitMessage(JSON.stringify({ type: 'write', seq: 2, data: 'b' }))
    await vi.waitFor(() => { expect(second.sent).toHaveLength(2) })
    expect(JSON.parse(second.sent[0]!)).toEqual({
      type: 'error', seq: 1, code: 'terminal/control-unavailable', message: 'denied', details: { reason: 'read-only' },
    })
    expect(JSON.parse(second.sent[1]!)).toEqual({ type: 'error', seq: 2, message: 'raw-string-error' })

    // Invalid frames close with 1008.
    const badJson = makeMockSocket()
    await bindTerminalInputSocket(badJson.socket, live.attachment, { maxInputBytes: 64, validateDimensions: () => {} }, controller.signal)
    badJson.emitMessage('{not-json')
    expect(badJson.closes.at(-1)).toEqual({ code: 1008, reason: 'invalid terminal input frame' })

    const badSeq = makeMockSocket()
    await bindTerminalInputSocket(badSeq.socket, live.attachment, { maxInputBytes: 64, validateDimensions: () => {} }, controller.signal)
    badSeq.emitMessage(JSON.stringify({ type: 'write', seq: 0, data: 'x' }))
    expect(badSeq.closes.at(-1)).toEqual({ code: 1008, reason: 'invalid terminal input frame' })

    const badType = makeMockSocket()
    await bindTerminalInputSocket(badType.socket, live.attachment, { maxInputBytes: 64, validateDimensions: () => {} }, controller.signal)
    badType.emitMessage(JSON.stringify({ type: 'unknown', seq: 1 }))
    expect(badType.closes.at(-1)).toEqual({ code: 1008, reason: 'invalid terminal input frame' })

    // Mid-flight ending before and after terminal.write + closed readyState sendFrame skip.
    const mid = makeMockSocket()
    let closedFlag = false
    const midAtt = makeAttachment({ isClosed: () => closedFlag })
    const gate = Promise.withResolvers<undefined>()
    midAtt.writeSpy.mockImplementationOnce(async () => {
      await gate.promise
      closedFlag = true
    })
    const input = bindTerminalInputSocket(mid.socket, midAtt.attachment, defaultLimits, controller.signal)
    mid.emitMessage(JSON.stringify({ type: 'write', seq: 1, data: 'first' }))
    mid.emitMessage(JSON.stringify({ type: 'write', seq: 2, data: 'queued-after-end' }))
    gate.resolve(undefined)
    await input
    expect(midAtt.writeSpy).toHaveBeenCalledExactlyOnceWith(midAtt.attachment.attachmentId, 'first')
    expect(mid.closes).toEqual([{ code: 1008, reason: 'terminal unavailable' }])

    // sendFrame skips when socket is closing/closed while write succeeded.
    const closingSock = makeMockSocket()
    const closingAtt = makeAttachment()
    closingAtt.writeSpy.mockImplementationOnce(async () => { closingSock.setState('closing') })
    await bindTerminalInputSocket(closingSock.socket, closingAtt.attachment, defaultLimits, controller.signal)
    closingSock.emitMessage(JSON.stringify({ type: 'write', seq: 1, data: 'ok' }))
    await vi.waitFor(() => { expect(closingAtt.writeSpy).toHaveBeenCalledOnce() })
    expect(closingSock.sent).toEqual([])

    const closingBeforeInput = makeMockSocket()
    const waitingAttachment = makeAttachment()
    const ending = new AbortController()
    const pendingInput = bindTerminalInputSocket(closingBeforeInput.socket, waitingAttachment.attachment, defaultLimits, ending.signal)
    closingBeforeInput.setState('closing')
    closingBeforeInput.emitMessage(JSON.stringify({ type: 'write', seq: 1, data: 'after closing' }))
    ending.abort()
    await pendingInput
    expect(waitingAttachment.writeSpy).not.toHaveBeenCalled()

    // Exceeding MAX_PENDING_INPUT_FRAMES closes the socket with 1008.
    const floodSock = makeMockSocket()
    const floodAtt = makeAttachment()
    const floodGate = Promise.withResolvers<undefined>()
    floodAtt.writeSpy.mockImplementationOnce(async () => { await floodGate.promise })
    const floodWork = bindTerminalInputSocket(floodSock.socket, floodAtt.attachment, defaultLimits, controller.signal)
    for (let i = 1; i <= 65; i++) {
      floodSock.emitMessage(JSON.stringify({ type: 'write', seq: i, data: 'x' }))
    }
    expect(floodSock.closes.at(-1)).toEqual({ code: 1008, reason: 'terminal input queue full' })
    floodGate.resolve(undefined)
    await floodWork
  })
})
