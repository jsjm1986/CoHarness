/** Terminal input acknowledgement, reconnect, and safe RPC fallback in the browser. */
import { RemoteStream, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { streamMethod } from '@deepseek-ai/dsh-remote-mock'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  openWebSocketTerminalInputChannel,
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

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) throw new Error('The stream fixture requires an abort signal')
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

describe('openWebSocketTerminalInputChannel browser client', () => {
  const target = {
    sessionId: 'session-1' as SessionId,
    terminalId: 'term-1' as WebTerminalId,
    attachmentId: 'att-1' as TerminalAttachmentId,
  }

  class FakeWebSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    static instances: FakeWebSocket[] = []
    static throwOnConstruct = false

    readyState = FakeWebSocket.CONNECTING
    readonly sent: string[] = []
    readonly closedWith: Array<{ code?: number; reason?: string }> = []
    throwOnSend = false

    constructor(readonly url: string) {
      super()
      if (FakeWebSocket.throwOnConstruct) throw new Error('blocked')
      FakeWebSocket.instances.push(this)
    }

    send(data: string): void {
      if (this.throwOnSend) throw new Error('send failed')
      this.sent.push(data)
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw new DOMException('Invalid browser WebSocket close code', 'InvalidAccessError')
      }
      this.closedWith.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
      this.readyState = FakeWebSocket.CLOSED
      this.dispatchEvent(new Event('close'))
    }

    emitMessage(data: unknown): void {
      this.dispatchEvent(new MessageEvent('message', { data }))
    }

    emitError(): void {
      this.dispatchEvent(new Event('error'))
    }
  }

  afterEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.throwOnConstruct = false
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns undefined without WebSocket, location, valid URL, or on constructor throw', () => {
    vi.stubGlobal('WebSocket', undefined)
    expect(openWebSocketTerminalInputChannel(target)).toBeUndefined()

    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('location', undefined)
    expect(openWebSocketTerminalInputChannel(target)).toBeUndefined()

    vi.stubGlobal('location', { href: 'https://harness.example/workbench' })
    expect(openWebSocketTerminalInputChannel(target, () => 'http://[::1')).toBeUndefined()

    FakeWebSocket.throwOnConstruct = true
    expect(openWebSocketTerminalInputChannel(target)).toBeUndefined()
  })

  it('handles wss/ws framing, ack/error/RemoteError, malformed frames, send failures, timeouts, and close', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('location', { href: 'https://harness.example/workbench' })

    const ch = openWebSocketTerminalInputChannel(target, value => `${value}&dshPrincipal=7`, { ackTimeoutMs: 500 })!
    const ws = FakeWebSocket.instances[0]!
    expect(ws.url).toMatch(/^wss:\/\/harness\.example\/api\/terminal\/input\?/)
    expect(ws.url).toContain('dshPrincipal=7')
    expect(ch.isOpen).toBe(false)

    // Before open -> unavailable error.
    await expect(ch.write('early')).rejects.toBeInstanceOf(TerminalInputChannelUnavailableError)

    ws.readyState = FakeWebSocket.OPEN
    expect(ch.isOpen).toBe(true)

    // Write + ack, resize + ack.
    const w1 = ch.write('ls\r')
    const r1 = ch.resize(120, 40)
    expect(ws.sent.map((raw): unknown => JSON.parse(raw))).toEqual([
      { type: 'write', seq: 1, data: 'ls\r' },
      { type: 'resize', seq: 2, cols: 120, rows: 40 },
    ])
    // Ignored frames: non-string, invalid JSON, non-object/bad seq, unknown type, unknown seq.
    ws.emitMessage(new Uint8Array([1]))
    ws.emitMessage('{bad')
    ws.emitMessage(JSON.stringify({ type: 'ack', seq: 0 }))
    ws.emitMessage(JSON.stringify({ type: 'other', seq: 1 }))
    ws.emitMessage(JSON.stringify({ type: 'ack', seq: 999 }))
    ws.emitMessage(JSON.stringify({ type: 'ack', seq: 1 }))
    ws.emitMessage(JSON.stringify({ type: 'ack', seq: 2 }))
    await expect(w1).resolves.toBeUndefined()
    await expect(r1).resolves.toBeUndefined()

    // Error frame with code + details -> RemoteError; without code -> plain Error.
    const wErrCode = ch.write('denied')
    const wErrCodeNoDetails = ch.write('denied-no-details')
    const wErrPlain = ch.write('plain')
    ws.emitMessage(JSON.stringify({ type: 'error', seq: 3, code: 'terminal/forbidden', message: 'no', details: { x: 1 } }))
    ws.emitMessage(JSON.stringify({ type: 'error', seq: 4, code: 'terminal/unavailable', message: 'gone' }))
    ws.emitMessage(JSON.stringify({ type: 'error', seq: 5, message: 'plain failure' }))
    await expect(wErrCode).rejects.toMatchObject({ code: 'terminal/forbidden', message: 'no', details: { x: 1 } })
    await expect(wErrCodeNoDetails).rejects.toMatchObject({ code: 'terminal/unavailable', message: 'gone', details: {} })
    await expect(wErrPlain).rejects.toThrow('plain failure')

    // Error event closes socket and rejects pending; repeated error on closed socket is a safe no-op.
    const wDrop = ch.write('drop')
    ws.emitError()
    ws.emitError()
    await expect(wDrop).rejects.toBeInstanceOf(TerminalInputChannelClosedError)
    expect(ch.isOpen).toBe(false)
    // Closing again when already CLOSED is a safe no-op.
    ch.close()

    // http: protocol maps to ws:, send() throw rejects with UnavailableError, and close() closes open socket.
    vi.stubGlobal('location', { href: 'http://127.0.0.1:3000/' })
    const ch2 = openWebSocketTerminalInputChannel(target)!
    const ws2 = FakeWebSocket.instances[1]!
    expect(ws2.url).toMatch(/^ws:\/\/127\.0\.0\.1:3000\//)
    ws2.readyState = FakeWebSocket.OPEN
    ws2.throwOnSend = true
    await expect(ch2.write('throw')).rejects.toBeInstanceOf(TerminalInputChannelUnavailableError)

    // ACK timeout closes half-open socket and rejects pending write with ClosedError.
    vi.useFakeTimers()
    const ch3 = openWebSocketTerminalInputChannel(target, undefined, { ackTimeoutMs: 100 })!
    const ws3 = FakeWebSocket.instances[2]!
    ws3.readyState = FakeWebSocket.OPEN
    const hung = ch3.write('stuck')
    const assertion = expect(hung).rejects.toBeInstanceOf(TerminalInputChannelClosedError)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(ws3.closedWith).toEqual([{ code: 4000, reason: 'ack timeout' }])
    expect(ch3.signal?.aborted).toBe(true)

    // Explicit close on CONNECTING socket uses 1000 detached.
    const ch4 = openWebSocketTerminalInputChannel(target)!
    const ws4 = FakeWebSocket.instances[3]!
    ch4.close()
    expect(ws4.closedWith).toEqual([{ code: 1000, reason: 'detached' }])

    // Timeout firing after socket already moved to CLOSING skips duplicate close().
    const ch5 = openWebSocketTerminalInputChannel(target, undefined, { ackTimeoutMs: 50 })!
    const ws5 = FakeWebSocket.instances[4]!
    ws5.readyState = FakeWebSocket.OPEN
    const hung5 = ch5.write('closing')
    const assertion5 = expect(hung5).rejects.toBeInstanceOf(TerminalInputChannelClosedError)
    ws5.readyState = FakeWebSocket.CLOSING
    await vi.advanceTimersByTimeAsync(50)
    await assertion5
    expect(ws5.closedWith).toEqual([])
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
        await untilAborted(signal)
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
        await untilAborted(signal)
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
    const model = new TerminalView(sessionId, remote, gateway, info.id, true, undefined, undefined, undefined, factory, 20)
    cleanups.push(() => model.dispose())
    return { model, remote }
  }

  it('recovers idle socket closures and only sends new input after an acknowledgement is lost', async () => {
    const opened: Array<{ lifetime: AbortController; write: Mock<TerminalInputChannel['write']>; resize: Mock<TerminalInputChannel['resize']> }> = []
    const initial = new AbortController()
    initial.abort()
    const factory = vi.fn((): TerminalInputChannel => {
      const lifetime = opened.length === 0 ? initial : new AbortController()
      const write = vi.fn<TerminalInputChannel['write']>(async () => {})
      const resize = vi.fn<TerminalInputChannel['resize']>(async () => {})
      opened.push({ lifetime, write, resize })
      return { signal: lifetime.signal, isOpen: true, write, resize, close: () => { lifetime.abort() } }
    })
    const { model, remote } = clientFixture(factory)
    model.mount()
    await expect.poll(() => opened.length).toBe(2)
    opened[1]!.lifetime.abort()
    await expect.poll(() => opened.length).toBe(3)

    const uncertain = Promise.withResolvers<undefined>()
    opened[2]!.write.mockReturnValueOnce(uncertain.promise)
    model.write('already submitted')
    await expect.poll(() => opened[2]!.write.mock.calls).toEqual([['already submitted']])
    opened[2]!.lifetime.abort()
    uncertain.reject(new TerminalInputChannelClosedError())
    await expect.poll(() => opened.length).toBe(4)
    model.write('new input')
    await expect.poll(() => opened[3]!.write.mock.calls).toEqual([['new input']])
    expect(remote.write).not.toHaveBeenCalled()

    const resize = Promise.withResolvers<undefined>()
    opened[3]!.resize.mockReturnValueOnce(resize.promise)
    model.resize(110, 35)
    await expect.poll(() => opened[3]!.resize.mock.calls).toEqual([[110, 35]])
    opened[3]!.lifetime.abort()
    resize.reject(new TerminalInputChannelClosedError())
    await expect.poll(() => opened.length).toBe(5)
    expect(remote.resize).toHaveBeenCalledExactlyOnceWith(sessionId, info.id, expect.any(String), 110, 35)
  })

  it('routes writes and resizes over an open input channel, falls back on unavailable/closed errors, and schedules reconnect', async () => {
    let open = true
    let writeError: Error | undefined
    let resizeError: Error | undefined
    const writes: string[] = []
    const resizes: string[] = []
    const closeSpy = vi.fn()
    const makeChannel = (): TerminalInputChannel => ({
      get isOpen() { return open },
      write: vi.fn(async (data: string) => {
        if (writeError !== undefined) {
          const err = writeError
          writeError = undefined
          throw err
        }
        writes.push(data)
      }),
      resize: vi.fn(async (cols: number, rows: number) => {
        if (resizeError !== undefined) {
          const err = resizeError
          resizeError = undefined
          throw err
        }
        resizes.push(`${cols}x${rows}`)
      }),
      close: closeSpy,
    })
    const factory = vi.fn(() => makeChannel())
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

    // Mid-flight write UnavailableError drops channel and transparently falls back to HTTP, then reconnects WS.
    writeError = new TerminalInputChannelUnavailableError()
    model.write('fallback-write')
    await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(1)
    expect(remote.write).toHaveBeenCalledWith(sessionId, info.id, expect.any(String), 'fallback-write')
    await expect.poll(() => factory.mock.calls.length).toBe(2)

    // Mid-flight write ClosedError drops channel without duplicating non-idempotent input and schedules WS reconnect.
    writeError = new TerminalInputChannelClosedError()
    model.write('in-flight-drop')
    await expect.poll(() => factory.mock.calls.length).toBe(3)
    expect(remote.write).toHaveBeenCalledTimes(1)

    // Mid-flight resize ClosedError falls back safely to idempotent HTTP resize and schedules WS reconnect.
    resizeError = new TerminalInputChannelClosedError()
    model.resize(110, 35)
    await expect.poll(() => vi.mocked(remote.resize).mock.calls.length).toBe(1)
    expect(remote.resize).toHaveBeenCalledWith(sessionId, info.id, expect.any(String), 110, 35)
    await expect.poll(() => factory.mock.calls.length).toBe(4)

    // Non-channel resize error fails the view rather than falling back.
    resizeError = new Error('fatal resize')
    model.resize(115, 36)
    await expect.poll(() => model.state.getSnapshot().error).toBe('fatal resize')

    // Reconnect after failure -> when channel is not open, writes use HTTP directly.
    open = false
    model.connect()
    await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
    model.write('http-when-closed')
    await expect.poll(() => vi.mocked(remote.write).mock.calls.length).toBe(2)

    // Disposing while a reconnect timer is armed cancels the timer cleanly without re-opening.
    open = true
    model.connect()
    await expect.poll(() => model.state.getSnapshot().writable).toBe(true)
    const callsBefore = factory.mock.calls.length
    writeError = new TerminalInputChannelClosedError()
    model.write('cancel-reconnect')
    await expect.poll(() => closeSpy.mock.calls.length).toBeGreaterThan(0)
    await model.dispose()
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    expect(factory.mock.calls.length).toBe(callsBefore)

    // Reconnect timer firing after view loses writability aborts safely without opening a channel.
    const { model: m2, remote: r2 } = clientFixture(factory)
    const stateGate = Promise.withResolvers<undefined>()
    vi.mocked(r2.follow).mockImplementationOnce(streamMethod<TerminalRemote['follow']>(async function* (_s, id, attId, signal) {
      yield { type: 'snapshot', sequence: 0, screen: 'ready', info: { ...info, id, controllerId: attId } }
      await stateGate.promise
      // Second writable state frame for the same attachment reuses the existing channel without reopening.
      yield { type: 'state', info: { ...info, id, controllerId: attId } }
      await untilAborted(signal)
    }))
    m2.mount()
    await m2.refresh()
    await expect.poll(() => m2.state.getSnapshot().writable).toBe(true)
    const r2Render = m2.state.getSnapshot().render
    if (r2Render !== undefined) m2.acknowledge(r2Render.revision)
    const beforeSameState = factory.mock.calls.length
    stateGate.resolve(undefined)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(factory.mock.calls.length).toBe(beforeSameState)

    // Reconnect timer fires after snapshot flips unwritable -> skips reopen.
    const beforeM2 = factory.mock.calls.length
    writeError = new TerminalInputChannelClosedError()
    m2.write('drop-then-readonly')
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    m2.state.set({ ...m2.state.getSnapshot(), writable: false })
    await new Promise((resolve) => { setTimeout(resolve, 35) })
    expect(factory.mock.calls.length).toBe(beforeM2)

    // Late ClosedError from a superseded attachment does not drop the newer attachment's input channel.
    const staleGate = Promise.withResolvers<undefined>()
    let staleAttempt = 0
    const staleCloseSpies: Array<ReturnType<typeof vi.fn>> = []
    const staleFactory = vi.fn((): TerminalInputChannel => {
      const close = vi.fn()
      staleCloseSpies.push(close)
      return {
        isOpen: true,
        write: vi.fn(async () => {
          if (++staleAttempt === 1) {
            await staleGate.promise
            throw new TerminalInputChannelClosedError()
          }
        }),
        resize: vi.fn(async () => {}),
        close,
      }
    })
    const { model: mStale } = clientFixture(staleFactory)
    mStale.mount()
    await mStale.refresh()
    await expect.poll(() => mStale.state.getSnapshot().writable).toBe(true)
    mStale.write('stale-in-flight')
    await expect.poll(() => staleAttempt).toBe(1)
    mStale.connect()
    await expect.poll(() => staleFactory.mock.calls.length).toBe(2)
    staleGate.resolve(undefined)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(staleCloseSpies[1]).not.toHaveBeenCalled()

    // Existing terminal recovered during refresh aborts speculative shells discovery cleanly.
    const { model: m3, remote: r3 } = clientFixture(() => undefined)
    vi.mocked(r3.list).mockResolvedValueOnce(ok([info]))
    m3.mount()
    await m3.refresh()
    await expect.poll(() => m3.state.getSnapshot().writable).toBe(true)
    expect(closeSpy).toHaveBeenCalled()
  })

  it('propagates RemoteError from the input channel identically to HTTP RPCs and handles speculative shells rejection', async () => {
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

    // Speculative shells rejection surfaces cleanly when creating a missing terminal.
    const { model: failing, remote: failingRemote } = clientFixture(() => undefined)
    vi.mocked(failingRemote.shells).mockRejectedValueOnce(new Error('shells offline'))
    await failing.refresh()
    expect(failing.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'shells offline' })

    // Stops reconnecting after MAX_INPUT_RECONNECT_ATTEMPTS consecutive unopened failures.
    let deadAttempts = 0
    const deadFactory = vi.fn((): TerminalInputChannel => {
      deadAttempts += 1
      const dead = new AbortController()
      dead.abort()
      return { signal: dead.signal, isOpen: false, write: async () => {}, resize: async () => {}, close: () => {} }
    })
    const { model: mDead } = clientFixture(deadFactory)
    mDead['inputReconnectDelayMs' as never] = 1 as never
    mDead.mount()
    await expect.poll(() => deadAttempts).toBe(6)
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    expect(deadAttempts).toBe(6)
  })
})
