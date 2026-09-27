/** Session- and path-authorized reads of immutable per-turn workspace snapshots. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { environmentForAgent } from '@deepseek-ai/dsh-agent-presets'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { CollaborationError, collaborationRefusal } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'
import type { RpcError, RpcRequest, RpcResponse } from './api/rpc.ts'
import type { WorkspaceChangesApi } from './api/workspace-changes.ts'
import type {} from './workspace-files.ts'

interface ReadOptions {
  authorize(sessionId: SessionId): Promise<{ authority: CollaborationAuthority | undefined } | { error: RpcError }>
  validateRoot(path: string, authority: CollaborationAuthority | undefined): Promise<string>
  principalSignal(signal: AbortSignal, authority: CollaborationAuthority | undefined): AbortSignal
  /**
   * Resolve a session's live Agent for sessions whose durable SSH binding
   * puts the workspace behind a realm filesystem; resuming re-runs the
   * caller's SSH admission. Sessions without a binding never consult it.
   * @param sessionId - the Session whose recorded change paths are validated.
   * @returns the Agent carrying the realm mount, or its caller-facing refusal.
   */
  agent?(sessionId: SessionId): Promise<{ agent: Agent } | { error: RpcError }>
}

/**
 * Create historical comparison methods using the same principal and path policy as Workspace reads.
 * @param ctx - recorder, Session headers, and filesystem services.
 * @param options - captured-principal authorization and runtime path policy.
 * @returns snapshot reads that recheck authorization after asynchronous work.
 */
export function createWorkspaceChangesApi(ctx: Context, options: ReadOptions): WorkspaceChangesApi {
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending])
  }, 'apiproxy: historical Workspace reads')

  async function checkPaths(sessionId: SessionId, summary: WorkspaceChangesSummary,
    authority: CollaborationAuthority | undefined, signal: AbortSignal): Promise<RpcError | undefined> {
    const header = ctx.sessions.get(sessionId)?.header ?? await ctx.get('sessionPersistence')?.readHeader(sessionId, signal)
    if (header?.cwd !== summary.cwd) throw new CollaborationError('forbidden')
    let fs: FileSystem
    let cwd: string
    let root: FsTarget | undefined
    if (header.sshTarget === undefined) {
      const host = ctx.get('fs')
      if (host === undefined) throw new Error('FS unavailable')
      fs = host
      cwd = await options.validateRoot(summary.cwd, authority)
    } else {
      // Recorded paths live on the session's remote realm: the host-side
      // project-root check cannot read a remote cwd, so the realm provider's
      // own resolve/contains enforce the boundary instead.
      if (options.agent === undefined) throw new CollaborationError('forbidden')
      const found = await options.agent(sessionId)
      if ('error' in found) return found.error
      const remote = environmentForAgent(ctx, found.agent, 'fs')
      if (remote === undefined) throw new Error('SSH-bound session has no realm filesystem')
      fs = remote
      cwd = summary.cwd
      root = await fs.resolve('.', { cwd, signal })
    }
    for (const file of summary.files) {
      signal.throwIfAborted()
      const target = await fs.resolve(file.path, { cwd, signal })
      if (root !== undefined && !fs.contains(root, target)) throw new CollaborationError('forbidden')
      const path = fs.processPath(target)
      if (header.sshTarget === undefined) await options.validateRoot(path, authority)
      await ctx.serial('workspace-files/authorize', sessionId, path)
    }
    return undefined
  }

  async function read<T>(request: RpcRequest<{ sessionId: SessionId; seq: number }>, external: AbortSignal | undefined,
    operation: (summary: WorkspaceChangesSummary, signal: AbortSignal) => Promise<T>): Promise<RpcResponse<T | null>> {
    const { sessionId, seq } = request.payload
    let signal = external === undefined ? lifetime.signal : AbortSignal.any([external, lifetime.signal])
    const work = (async (): Promise<RpcResponse<T | null>> => {
      try {
        signal.throwIfAborted()
        const access = await options.authorize(sessionId)
        if ('error' in access) return { rpcId: request.rpcId, result: { ok: false, error: access.error } }
        signal = options.principalSignal(signal, access.authority)
        signal.throwIfAborted()
        const summary = ctx.get('workspaceChanges')?.summary(sessionId, seq)
        if (summary === undefined) return { rpcId: request.rpcId, result: { ok: true, value: null } }
        const refused = await checkPaths(sessionId, summary, access.authority, signal)
        if (refused !== undefined) return { rpcId: request.rpcId, result: { ok: false, error: refused } }
        const value = await operation(summary, signal)
        const recheck = await checkPaths(sessionId, summary, access.authority, signal)
        if (recheck !== undefined) return { rpcId: request.rpcId, result: { ok: false, error: recheck } }
        await access.authority?.authorize(sessionId, 'read')
        signal.throwIfAborted()
        // Disposal invalidates the snapshot while a comparison is in flight.
        if (ctx.get('workspaceChanges')?.summary(sessionId, seq) !== summary) {
          return { rpcId: request.rpcId, result: { ok: true, value: null } }
        }
        return { rpcId: request.rpcId, result: { ok: true, value } }
      } catch (error: unknown) {
        const failure: RpcError = signal.aborted
          ? { code: 'cancelled', message: 'Workspace review was cancelled.', details: {} }
          : error instanceof CollaborationError ? collaborationRefusal(error, 'read', sessionId)
            : { code: 'internal', message: 'Workspace review could not be read.', details: {} }
        return { rpcId: request.rpcId, result: { ok: false, error: failure } }
      }
    })()
    pending.add(work)
    try { return await work } finally { pending.delete(work) }
  }

  return {
    summary: (request, signal) => read(request, signal, ({ turn, files, total, added, deleted }) =>
      Promise.resolve({ turn, files, total, added, deleted })),
    diff: (request, signal) => read(request, signal, async (_summary, abort) =>
      await ctx.get('workspaceChanges')?.diff(request.payload.sessionId, request.payload.seq, request.payload.index, abort) ?? null),
  }
}
