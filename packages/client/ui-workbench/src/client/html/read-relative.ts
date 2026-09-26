/** Dependency reads stay inside the source file's Session and workspace grammar. */
import { workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReadHtmlRelative } from './pack.ts'

/** Complete bytes for one workspace file on its owning runtime, including its freshness token. */
export interface WorkspaceFileData {
  readonly data: Uint8Array<ArrayBuffer>
  readonly version: string
}

/**
 * Read one file through the existing authorized Workspace service.
 * @param request - explicit runtime target, Session, and resource identity.
 * @param signal - cancellation shared by the preview and packing operation.
 * @returns complete bytes and the version they were read under.
 */
export type ReadWorkspaceFileData = (
  request: { resource: WorkspaceResourceOpenRequest; version?: string | undefined },
  signal: AbortSignal,
) => Promise<WorkspaceFileData>

/**
 * Fold `.` and `..` inside a workspace-relative path without a filesystem.
 * The Host's path grammar rejects surviving `..` segments, so references
 * resolving above the workspace root fail here instead of reaching the wire.
 * @param path - workspace-relative path after joining base directory and reference.
 * @returns normalized path, or undefined when it escapes the workspace root.
 */
export function normalizeWorkspacePath(path: string): string | undefined {
  const segments: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

/**
 * Bind a package reader to the original HTML file's resource request.
 * @param read - authorized complete-file read on the request's runtime and Session.
 * @param request - root HTML file resource.
 * @param lifetime - preview lifetime; dependencies never outlive their document.
 * @returns a reader that decodes one relative URL, resolves it against the
 * document's directory, and reads through the same Session-scoped service.
 */
export function createReadHtmlRelative(
  read: ReadWorkspaceFileData,
  request: WorkspaceResourceOpenRequest,
  lifetime: AbortSignal,
): ReadHtmlRelative {
  const base = request.path.slice(0, request.path.lastIndexOf('/') + 1)
  return async (reference, signal) => {
    const suffix = reference.search(/[?#]/u)
    const decoded = decodeURIComponent(suffix === -1 ? reference : reference.slice(0, suffix))
    if (decoded.length === 0 || /^(?:[a-z][a-z\d+.-]*:|[/\\])/iu.test(decoded) || decoded.includes('\0') || decoded.includes('\\')) {
      throw new Error('HTML dependency must use a relative file path')
    }
    const path = normalizeWorkspacePath(base + decoded)
    if (path === undefined) throw new Error('HTML dependency must stay inside the Session workspace')
    const combined = AbortSignal.any([lifetime, signal])
    combined.throwIfAborted()
    const resource: WorkspaceResourceOpenRequest = {
      runtimeTarget: request.runtimeTarget,
      sessionId: request.sessionId,
      path,
      address: workspaceResourceAddress(request.sessionId, path),
    }
    const file = await read({ resource }, combined)
    combined.throwIfAborted()
    return file.data
  }
}
