/**
 * The `IApiClient` face of a {@link RemoteMock}: every domain method dispatches
 * to the mock's endpoint table under its wire name (`sessions.list` →
 * `session.list`), mints a response `rpcId`, and wraps the registered
 * `RpcResult` in the `RpcResponse` envelope the connection layer consumes.
 * `events.mux`/`events.host` answer from the same stream scripts the `rpc`
 * carrier reads; `respond` dispatches the `respond` endpoint.
 */
import type {
  ClientResponse,
  IApiClient,
  RpcId,
  RpcReceipt,
  RpcRequest,
  RpcResponse,
  RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import type { RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Dispatch surface the api face needs; implemented by `RemoteMock`. */
export interface MockDispatch {
  /** Answer one unary call by endpoint name and positional args. */
  dispatch(endpoint: string, args: readonly unknown[]): Promise<unknown>
  /** Open one endpoint's stream script as an item source. */
  open(endpoint: string, args: readonly unknown[], signal: AbortSignal): AsyncIterable<unknown>
}

/**
 * Wire endpoint of each unary `IApiClient` domain method. The map is the
 * contract: coverage over the domain keys is compiler-enforced against
 * `IApiClient` (`events` and `respond` are handled separately), and each
 * value must name a real `RpcMethodMap` row.
 */
const API_METHODS = {
  sessions: {
    list: 'session.list',
    search: 'session.search',
    create: 'session.create',
    history: 'session.history',
    historyIndex: 'session.historyIndex',
    models: 'session.models',
    selectModel: 'session.selectModel',
    rename: 'session.rename',
    fork: 'session.fork',
    prompt: 'session.prompt',
    attachment: 'session.attachment',
    updateQueue: 'session.updateQueue',
    cancel: 'session.cancel',
  },
  subagents: { history: 'subagent.history' },
  jobs: { output: 'jobs.output', kill: 'jobs.kill' },
  host: {
    describe: 'host.describe',
    pickDirectory: 'host.pickDirectory',
    listDirectory: 'host.listDirectory',
    createDirectory: 'host.createDirectory',
    openPath: 'host.openPath',
    fileApplications: 'host.fileApplications',
  },
  workspace: {
    list: 'workspace.list',
    create: 'workspace.create',
    rename: 'workspace.rename',
    delete: 'workspace.delete',
    insertBefore: 'workspace.insertBefore',
    insertSessionBefore: 'workspace.insertSessionBefore',
    archiveSession: 'workspace.archiveSession',
    unarchiveSession: 'workspace.unarchiveSession',
    pinSession: 'workspace.pinSession',
    unpinSession: 'workspace.unpinSession',
  },
  desktop: { status: 'desktop.status', confirm: 'desktop.confirm' },
  workspaceChanges: { summary: 'workspaceChanges.summary', diff: 'workspaceChanges.diff' },
  workspaceFiles: {
    renderOffice: 'workspaceFiles.renderOffice',
    list: 'workspaceFiles.list',
    stat: 'workspaceFiles.stat',
    read: 'workspaceFiles.read',
    readBytes: 'workspaceFiles.readBytes',
  },
  skills: { list: 'skill.list' },
  agentPresets: { openDocument: 'agentPreset.openDocument' },
  settings: {
    describe: 'settings.describe',
    openDocument: 'settings.openDocument',
    update: 'settings.update',
    replace: 'settings.replace',
    mutate: 'settings.mutate',
  },
  credentials: {
    describe: 'credentials.describe',
    set: 'credentials.set',
    unset: 'credentials.unset',
  },
  llm: {
    providers: 'llm.providers',
    models: 'llm.models',
    discoverModels: 'llm.discoverModels',
  },
} as const satisfies { readonly [D in keyof Omit<IApiClient, 'events' | 'respond'>]: Record<keyof IApiClient[D], keyof RpcMethodMap & string> }

/** Mint one response id the way the real carrier does: the responder echoes the request's brand. */
function mintRpcId(seq: number): RpcId {
  return `mock-${String(seq)}` as RpcId
}

/** An item with a `payload` member is already a server-request envelope the consumer reads. */
function isEnvelope(item: unknown): item is RpcRequest<unknown> {
  return typeof item === 'object' && item !== null && 'payload' in item
}

/** Settle with the call, or reject with the abort reason first. */
function settleOrAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('remote-mock: call aborted', { cause: signal.reason }))
    }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    if (signal.aborted) abort()
  })
}

/**
 * Build the `IApiClient` face over `mock`. The payload the consumer passes
 * becomes the call's single positional arg, so a rule reads its request object
 * as `args[0]` — the same position the `rpc` carrier's `{ args }` object form
 * lands in.
 * @param mock - the endpoint table the face dispatches to.
 * @returns the api client.
 */
export function createMockApi(mock: MockDispatch): IApiClient {
  let seq = 0
  const unary = (endpoint: string) => async (payload: unknown, signal?: AbortSignal): Promise<RpcResponse<unknown>> => {
    const result = await settleOrAbort(mock.dispatch(endpoint, [payload]), signal)
    // The registered value is the response's result envelope, unchecked — the
    // same contract the `rpc` carrier face gives unary callers.
    return { rpcId: mintRpcId(++seq), result: result as RpcResult<unknown> }
  }
  // The contract opens the subscription at call time ("iteration drains
  // frames already captured"), so `mock.open` runs eagerly and onOpen fires
  // once the script has run — before any pull, like the real carrier.
  const stream = (endpoint: string) =>
    (payload: unknown, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<unknown>> => {
      const source = mock.open(endpoint, [payload], signal)
      onOpen?.()
      return (async function* () {
        for await (const item of source) {
          // An item already carrying a `payload` member is a full
          // server-request envelope (a test mints its rpcId to answer through
          // `respond`); anything else is a pure push wrapped with a fresh id.
          yield isEnvelope(item) ? item : { rpcId: mintRpcId(++seq), payload: item }
        }
      })()
    }
  const domains: Record<string, Record<string, unknown>> = {}
  for (const [domain, methods] of Object.entries(API_METHODS)) {
    const face: Record<string, unknown> = {}
    for (const [method, endpoint] of Object.entries(methods)) face[method] = unary(endpoint)
    domains[domain] = face
  }
  const events: IApiClient['events'] = {
    mux: stream('events.mux') as IApiClient['events']['mux'],
    host: stream('events.host') as IApiClient['events']['host'],
  }
  // `respond` carries a client-response, not a unary request; its answer is the carrier receipt.
  const respond: IApiClient['respond'] = async (message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt> =>
    await settleOrAbort(mock.dispatch('respond', [message]), signal) as RpcReceipt
  // The generated domains are per-method precise; the generic builder erases that, so the table (checked against
  // `RpcMethodMap` above) is the checked artifact and the face is cast once here.
  return { ...domains, events, respond } as unknown as IApiClient
}
