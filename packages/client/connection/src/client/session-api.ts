/** Session-aware API calls decode only the declared protocol address fields. */
import type { IApiClient, SessionId } from './api.ts'
import { parseClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Route browser Session keys to an exact runtime while retaining original wire payloads.
 * @param api - current connection's unwrapped API.
 * @param resolve - runtime API and original ID for one browser Session key.
 * @returns the API with declared Session-addressed methods routed.
 */
export function sessionAddressApi(
  api: IApiClient,
  resolve: (key: SessionId) => { api: IApiClient; sessionId: SessionId },
): IApiClient {
  type Unary = (...args: never[]) => Promise<unknown>
  const method = <F extends Unary>(select: (target: IApiClient) => F, fields: readonly string[]): F => {
    const invoke = (payload: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> => {
      let owner: IApiClient | undefined
      let mapped: Record<string, unknown> | undefined
      for (const field of fields) {
        const value = payload[field]
        if (typeof value !== 'string' || parseClientSessionKey(value) === undefined) continue
        const address = resolve(value as SessionId)
        if (owner !== undefined && owner !== address.api) throw new Error('Session request spans different runtimes')
        owner = address.api
        mapped ??= { ...payload }
        mapped[field] = address.sessionId
      }
      // The method roster below preserves each IApiClient signature; only its declared address fields change.
      return Reflect.apply(select(owner ?? api), undefined, [mapped ?? payload, signal]) as Promise<unknown>
    }
    return invoke as unknown as F
  }
  return {
    ...api,
    sessions: {
      ...api.sessions,
      history: method(a => a.sessions.history.bind(a.sessions), ['sessionId']),
      historyIndex: method(a => a.sessions.historyIndex.bind(a.sessions), ['sessionId']),
      models: method(a => a.sessions.models.bind(a.sessions), ['sessionId']),
      selectModel: method(a => a.sessions.selectModel.bind(a.sessions), ['sessionId']),
      rename: method(a => a.sessions.rename.bind(a.sessions), ['sessionId']),
      fork: method(a => a.sessions.fork.bind(a.sessions), ['sessionId']),
      prompt: method(a => a.sessions.prompt.bind(a.sessions), ['sessionId']),
      attachment: method(a => a.sessions.attachment.bind(a.sessions), ['sessionId']),
      updateQueue: method(a => a.sessions.updateQueue.bind(a.sessions), ['sessionId']),
      cancel: method(a => a.sessions.cancel.bind(a.sessions), ['sessionId']),
    },
    subagents: { history: method(a => a.subagents.history.bind(a.subagents), ['parentSessionId', 'childSessionId']) },
    desktop: {
      status: method(a => a.desktop.status.bind(a.desktop), ['sessionId']),
      confirm: method(a => a.desktop.confirm.bind(a.desktop), ['sessionId', 'rootSessionId']),
    },
    workspace: {
      ...api.workspace,
      insertSessionBefore: method(a => a.workspace.insertSessionBefore.bind(a.workspace), ['sessionId', 'beforeSessionId']),
      archiveSession: method(a => a.workspace.archiveSession.bind(a.workspace), ['sessionId']),
      unarchiveSession: method(a => a.workspace.unarchiveSession.bind(a.workspace), ['sessionId']),
      pinSession: method(a => a.workspace.pinSession.bind(a.workspace), ['sessionId']),
      unpinSession: method(a => a.workspace.unpinSession.bind(a.workspace), ['sessionId']),
    },
    workspaceChanges: {
      summary: method(a => a.workspaceChanges.summary.bind(a.workspaceChanges), ['sessionId']),
      diff: method(a => a.workspaceChanges.diff.bind(a.workspaceChanges), ['sessionId']),
    },
    workspaceFiles: {
      list: method(a => a.workspaceFiles.list.bind(a.workspaceFiles), ['sessionId']),
      stat: method(a => a.workspaceFiles.stat.bind(a.workspaceFiles), ['sessionId']),
      read: method(a => a.workspaceFiles.read.bind(a.workspaceFiles), ['sessionId']),
      readBytes: method(a => a.workspaceFiles.readBytes.bind(a.workspaceFiles), ['sessionId']),
      renderOffice: method(a => a.workspaceFiles.renderOffice.bind(a.workspaceFiles), ['sessionId']),
    },
    skills: { list: method(a => a.skills.list.bind(a.skills), ['sessionId']) },
    respond: api.respond.bind(api),
  }
}
