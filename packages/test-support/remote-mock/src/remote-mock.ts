/** `RemoteMock`: an endpoint table (unary answers or stream scripts), live stream control, a log, and the Connection carrier faces. */

import type {
  ClientTransportHooks,
  ClientConnectionRpc,
  ConnectionRpcResult,
  HostDescription,
  IApiClient,
} from '@deepseek-ai/dsh-client-connection/client'
import { fn, type Mock } from '@vitest/spy'
import { MockLogStore, type MockLog } from './log.ts'
import { MockStream, openStream, toError, type StreamScript } from './streams.ts'
import { createRemoteProxy, type MockedRemote } from './remote-proxy.ts'
import { createMockApi } from './api-client.ts'
import { MockAccountPreferences, MockProjectModelSettings } from './transports.ts'

/** A unary handler receives the caller's positional arguments, without its trailing `AbortSignal`. */
export type UnaryRuleFn<Args extends readonly unknown[] = readonly unknown[], Result = unknown> = (...args: Args) => Result

/** Endpoint defaults: unary values or positional handlers, stream scripts, and stream declarations. */
export interface RemoteTable {
  readonly unary?: Readonly<Record<string, unknown>>
  readonly stream?: Readonly<Record<string, StreamScript>>
  /** Endpoints declared as streams without a script, so an open finds a stream miss rather than a unary one. */
  readonly streams?: readonly string[]
}

/** Construction options. */
export interface RemoteMockOptions {
  /** Host facts the default `host.describe` answer carries; default `{ home: '/home/mock' }`. */
  readonly host?: { readonly home: string }
}

/** Filter over the args a stream was opened with. */
export type StreamFilter = (args: readonly unknown[]) => boolean

/** Control and synchronization for streams opened by registered scripts; native overrides are excluded. */
export interface OpenStreams {
  /**
   * Push one item into every open stream on `endpoint`, optionally filtered by its open args.
   * @param endpoint - endpoint.
   * @param item - item to deliver.
   * @param where - filter over open args.
   * @returns how many streams received it.
   */
  push(endpoint: string, item: unknown, where?: StreamFilter): number
  /**
   * End every matching open stream.
   * @param endpoint - endpoint.
   * @param where - filter over open args.
   * @returns how many streams ended.
   */
  end(endpoint: string, where?: StreamFilter): number
  /**
   * Fail every matching open stream with `error`.
   * @param endpoint - endpoint.
   * @param error - error the consumer's read rejects with.
   * @param where - filter over open args.
   * @returns how many streams failed.
   */
  fail(endpoint: string, error: Error, where?: StreamFilter): number
  /**
   * Resolve once registered scripts have opened `endpoint` at least `count` times in total.
   * @param endpoint - endpoint.
   * @param count - opens to wait for.
   */
  opened(endpoint: string, count: number): Promise<void>
  /**
   * Resolve once the consumer of every matching stream has pulled everything pushed so far and, for a stream still
   * open, waits for more; a settled stream counts once its queue is empty, and a stream nobody reads never drains.
   * Pulled means taken from the queue: a consumer that processes items asynchronously after pulling them may still
   * be working on the last one.
   * @param endpoint - endpoint.
   * @param where - filter over open args.
   */
  drained(endpoint: string, where?: StreamFilter): Promise<void>
}

/**
 * The success envelope the Client's Remote and API callers read: `{ ok: true, value }` —
 * `RpcResult`/`ConnectionRpcResult`/`RemoteResult` share the same pair.
 * @param value - success value.
 * @returns the envelope.
 */
export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

interface OpenWaiter {
  readonly endpoint: string
  readonly count: number
  resolve(): void
}

/** A missing default answer is an unmatched request, not a selected rule that failed. */
class MissingUnaryRule extends Error {}

/** An item that already is a result envelope passes through the `rpc.stream` wrap unchanged. */
function isResultEnvelope(item: unknown): item is ConnectionRpcResult<unknown> {
  return typeof item === 'object' && item !== null && typeof (item as { ok?: unknown }).ok === 'boolean'
}

/**
 * Endpoint-named Remote/API mock. `dispatch` / `open` are the core; `rpc` and
 * `api` are the same core behind the decoded carrier faces the Connection
 * installer accepts (`rpc` for Gateway remote traffic, `api` for the
 * handwritten domain methods; both share the endpoint table, the log, and
 * the stream controls).
 */
export class RemoteMock {
  /**
   * Create a mock answering the Connection handshake: `host.describe`
   * describes `options.host`, and `events.mux`/`events.host` stay open without
   * frames, so the assembled client connects and stays connected.
   * @param options - host facts for the describe answer.
   * @returns the mock.
   */
  static create(options: RemoteMockOptions = {}): RemoteMock {
    const host = options.host ?? { home: '/home/mock' }
    return new RemoteMock()
      .unary('host.describe', () => ok<HostDescription>({
        version: 'mock',
        cwd: host.home,
        attachedSessions: 0,
        home: host.home,
        canOpenPath: false,
      }))
      .stream('events.mux', openStream())
      .stream('events.host', openStream())
  }

  private readonly unaryDefaults = new Map<string, unknown>()
  private readonly scripts = new Map<string, StreamScript | undefined>()
  private live: MockStream[] = []
  private openWaiters: OpenWaiter[] = []
  private readonly logStore = new MockLogStore()
  private readonly unaryMocks = new Map<string, Mock<UnaryRuleFn>>()
  private readonly streamMocks = new Map<string, Mock<UnaryRuleFn>>()
  private readonly proxy = createRemoteProxy(endpoint => this.modeOf(endpoint) === 'stream'
    ? this.streamMock(endpoint)
    : this.unaryMock(endpoint))

  /**
   * Native mock functions for every namespace: configure answers and inspect calls without declaring method names.
   * Explicit stream registrations select stream mocks; all other methods use unary mocks.
   * Native overrides belong to this instance; `mockReset()` restores the implementation reading current defaults.
   * Generated declarations provide exact signatures; absent declarations weaken only this test-owned proxy.
   */
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Only this test proxy becomes any without generated namespaces.
  readonly remote: MockedRemote = this.proxy as MockedRemote

  /** The handwritten domain API the runtime's object layer calls directly. */
  readonly api: IApiClient = createMockApi(this)

  /** In-memory account-preference carrier (absent carrier disables account scopes, which boots also exercise). */
  readonly accountPreferences = new MockAccountPreferences()

  /** In-memory project-Provider carrier for project settings surfaces. */
  readonly projectModelSettings = new MockProjectModelSettings()

  /** Everything observed so far. */
  readonly log: MockLog = this.logStore

  /** Control over streams opened by registered scripts. */
  readonly streams: OpenStreams = {
    push: (endpoint, item, where) => this.forEachOpen(endpoint, where, (stream) => { stream.push(item) }),
    end: (endpoint, where) => this.forEachOpen(endpoint, where, (stream) => { stream.end() }),
    fail: (endpoint, error, where) => this.forEachOpen(endpoint, where, (stream) => { stream.fail(error) }),
    opened: (endpoint, count) => {
      if (this.logStore.streams(endpoint).length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => { this.openWaiters.push({ endpoint, count, resolve }) })
    },
    drained: (endpoint, where) => Promise.all(this.matching(endpoint, where).map(stream => stream.drained())).then(() => undefined),
  }

  /**
   * The Connection carrier face: `call` dispatches, `stream` opens. Payloads
   * carry `{ args }` — the positional array the namespace proxies send, or the
   * one object API-domain endpoints send — and a call aborted by its signal
   * rejects. `stream` yields `{ ok: true, value }` envelopes per script item;
   * an item already carrying a boolean `ok` passes through as the wire result.
   */
  readonly rpc: ClientConnectionRpc = {
    call: async (_channel, endpoint, payload, signal) => {
      const pending = this.dispatch(endpoint, argsOf(endpoint, payload))
      const value = await (signal === undefined ? pending : settleOrAbort(pending, signal))
      // The carrier contract names the result envelope; the registered value is taken as that envelope unchecked.
      return value as ConnectionRpcResult<unknown>
    },
    stream: (_channel, endpoint, payload, signal) => this.streamResults(endpoint, argsOf(endpoint, payload), signal),
  }

  /**
   * The `ClientTransportHooks` half a test supplies to `installConnection`:
   * this mock's api, RPC, account, and project carriers.
   */
  get transport(): ClientTransportHooks {
    return {
      createApiClient: () => this.api,
      rpc: this.rpc,
      createAccountPreferencesTransport: () => this.accountPreferences,
      createProjectModelSettingsTransport: () => this.projectModelSettings,
    }
  }

  private constructor() {}

  /**
   * Set the endpoint's default positional-argument handler without changing its native mock overrides.
   * @param endpoint - `<namespace>/<method>` or `<domain>.<method>`.
   * @param rule - handler computing the answer.
   * @returns this.
   */
  unary<Args extends readonly unknown[]>(endpoint: string, rule: UnaryRuleFn<Args>): this
  /**
   * Set the endpoint's default answer, including explicit `undefined`, without changing its native mock overrides.
   * @param endpoint - `<namespace>/<method>` or `<domain>.<method>`.
   * @param rule - default answer.
   * @returns this.
   */
  unary(endpoint: string, rule: unknown): this
  unary(endpoint: string, rule: unknown): this {
    this.unaryDefaults.set(endpoint, rule)
    return this
  }

  /**
   * Declare `endpoint` as a stream and replace its default script when supplied. A declaration without a script
   * preserves any existing script; an endpoint declared without one fails an open as a stream miss.
   * @param endpoint - `<namespace>/<method>` or `<domain>.<method>`.
   * @param script - script (`frames` / `openStream` build the common ones).
   * @returns this.
   */
  stream(endpoint: string, script?: StreamScript): this {
    if (script !== undefined || !this.scripts.has(endpoint)) this.scripts.set(endpoint, script)
    return this
  }

  /**
   * Register endpoint defaults without changing native mock overrides.
   * @param table - unary answers and stream scripts.
   * @returns this.
   */
  load(table: RemoteTable): this {
    for (const [endpoint, rule] of Object.entries(table.unary ?? {})) this.unary(endpoint, rule)
    for (const endpoint of table.streams ?? []) this.stream(endpoint)
    for (const [endpoint, script] of Object.entries(table.stream ?? {})) this.stream(endpoint, script)
    return this
  }

  /**
   * Whether `endpoint` is declared a stream (with or without a script) or has a unary rule — the one declaration
   * the whole-client proxies need; an endpoint neither declared nor ruled is dispatched as a unary call.
   * @param endpoint - endpoint.
   * @returns the mode, or undefined when nothing is registered.
   */
  modeOf(endpoint: string): 'unary' | 'stream' | undefined {
    if (this.scripts.has(endpoint)) return 'stream'
    if (this.unaryDefaults.has(endpoint)) return 'unary'
    return undefined
  }

  /**
   * Registered endpoints and accessed proxy methods, sorted.
   * @returns endpoint names.
   */
  endpoints(): readonly string[] {
    const names = new Set<string>(this.scripts.keys())
    for (const endpoint of this.unaryDefaults.keys()) names.add(endpoint)
    for (const [namespace, methods] of Object.entries(this.proxy)) {
      for (const method of Object.keys(methods)) names.add(`${namespace}/${method}`)
    }
    return [...names].sort()
  }

  /**
   * Answer one unary call with the registered rule's value, verbatim. The call
   * is logged as soon as its rule is selected and settles with the rule: a
   * rule that throws or rejects fails the call with that error.
   * @param endpoint - endpoint.
   * @param args - positional args.
   * @returns the answer.
   * @throws {Error} when no rule is registered (logged as unmatched).
   */
  async dispatch(endpoint: string, args: readonly unknown[]): Promise<unknown> {
    let answer: unknown
    try {
      answer = this.unaryMock(endpoint)(...args)
    } catch (error) {
      if (error instanceof MissingUnaryRule) throw error
      answer = Promise.reject(toError(error))
    }
    const record = this.logStore.call(endpoint, args)
    try {
      record.result = await answer
    } catch (error) {
      record.state = 'failed'
      record.result = error
      throw error
    }
    record.state = 'answered'
    return record.result
  }

  private unaryMock(endpoint: string): Mock<UnaryRuleFn> {
    let mock = this.unaryMocks.get(endpoint)
    if (mock === undefined) {
      mock = fn((...args: readonly unknown[]) => Promise.resolve(this.unaryAnswer(endpoint, args)))
      this.unaryMocks.set(endpoint, mock)
    }
    return mock
  }

  private unaryAnswer(endpoint: string, args: readonly unknown[]): unknown {
    if (!this.unaryDefaults.has(endpoint)) {
      this.logStore.miss(endpoint, 'unary')
      throw new MissingUnaryRule(this.noRuleMessage(endpoint))
    }
    const rule = this.unaryDefaults.get(endpoint)
    return isRuleFn(rule) ? answerOf(rule, args) : rule
  }

  /**
   * Open through the endpoint's native mock, which is called with the generated
   * signature's arguments only; its default runs the registered script as a
   * controlled stream. A native override returns its own iterable: the caller
   * owns consumption and cancellation, outside `OpenStreams`.
   * @param endpoint - endpoint.
   * @param args - positional args.
   * @param signal - consumer cancellation.
   * @returns the controlled script stream or the native override's caller-owned iterable.
   * @throws {Error} when the default runs without a registered script (logged as unmatched).
   */
  open(
    endpoint: string,
    args: readonly unknown[],
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    return this.streamMock(endpoint)(...args, signal) as AsyncIterable<unknown>
  }

  private streamMock(endpoint: string): Mock<UnaryRuleFn> {
    let mock = this.streamMocks.get(endpoint)
    if (mock === undefined) {
      mock = fn((...values: readonly unknown[]) => {
        const args = [...values]
        const signal = args.at(-1) instanceof AbortSignal ? args.pop() as AbortSignal : new AbortController().signal
        return this.openScript(endpoint, args, signal)
      })
      this.streamMocks.set(endpoint, mock)
    }
    return mock
  }

  private openScript(endpoint: string, args: readonly unknown[], signal: AbortSignal): MockStream {
    const script = this.scripts.get(endpoint)
    if (script === undefined) {
      this.logStore.miss(endpoint, 'stream')
      throw new Error(this.noRuleMessage(endpoint))
    }
    const stream = new MockStream(this.logStore.stream(endpoint, args), signal)
    this.live.push(stream)
    this.wakeOpened(endpoint)
    stream.run(script, args)
    return stream
  }

  /** Throw when any request found no rule, naming the endpoints and the registered ones. */
  assertNoUnmatched(): void {
    const unmatched = this.logStore.unmatched()
    if (unmatched.length === 0) return
    const lines = unmatched.map(entry => `  ${entry.endpoint} (${entry.mode})`)
    throw new Error(`remote-mock: ${String(unmatched.length)} unmatched request(s):\n${lines.join('\n')}\nregistered: ${this.endpoints().join(', ')}`)
  }

  private noRuleMessage(endpoint: string): string {
    return `remote-mock: no rule for ${endpoint}; registered: ${this.endpoints().join(', ')}`
  }

  /** Wrap one opened item stream in per-item result envelopes for the `rpc.stream` carrier contract. */
  private async *streamResults(
    endpoint: string,
    args: readonly unknown[],
    signal: AbortSignal,
  ): AsyncIterable<ConnectionRpcResult<unknown>> {
    for await (const item of this.open(endpoint, args, signal)) {
      yield isResultEnvelope(item) ? item : { ok: true, value: item }
    }
  }

  /** Streams on `endpoint` still open or still holding items their consumer has not pulled; the rest are forgotten. */
  private matching(endpoint: string, where: StreamFilter | undefined): MockStream[] {
    this.live = this.live.filter(stream => stream.record.state === 'open' || stream.queued > 0)
    return this.live.filter(stream => stream.record.endpoint === endpoint && (where === undefined || where(stream.record.args)))
  }

  private forEachOpen(endpoint: string, where: StreamFilter | undefined, action: (stream: MockStream) => void): number {
    const targets = this.matching(endpoint, where).filter(stream => stream.record.state === 'open')
    for (const stream of targets) action(stream)
    return targets.length
  }

  private wakeOpened(endpoint: string): void {
    const opened = this.logStore.streams(endpoint).length
    const ready = this.openWaiters.filter(waiter => waiter.endpoint === endpoint && opened >= waiter.count)
    this.openWaiters = this.openWaiters.filter(waiter => !ready.includes(waiter))
    for (const waiter of ready) waiter.resolve()
  }
}

function isRuleFn(rule: unknown): rule is UnaryRuleFn {
  return typeof rule === 'function'
}

/** A rule's synchronous throw becomes a rejection so the call settles through one path. */
function answerOf(rule: UnaryRuleFn, args: readonly unknown[]): unknown {
  try {
    return rule(...args)
  } catch (error) {
    return Promise.reject(toError(error))
  }
}

/** Positional args from a carrier payload: the array the namespace proxies send, or the one object API endpoints send. */
function argsOf(endpoint: string, payload: unknown): readonly unknown[] {
  if (typeof payload === 'object' && payload !== null && 'args' in payload) {
    const { args } = payload
    if (Array.isArray(args)) return args
    if (typeof args === 'object' && args !== null) return [args]
  }
  throw new TypeError(`remote-mock: payload of ${endpoint} must be { args: unknown[] | object }`)
}

/**
 * Settle with the call, or reject with the abort reason first; the call itself
 * always keeps a handler so its own outcome is never an unhandled rejection.
 */
function settleOrAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('remote-mock: call aborted', { cause: signal.reason })) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    if (signal.aborted) abort()
  })
}
