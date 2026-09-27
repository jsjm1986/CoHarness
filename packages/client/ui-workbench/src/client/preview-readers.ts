/** Versioned file reads on the request's explicit connection target. */
import { WorkspaceResourceError } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ReadWorkspaceDocument } from './components/WorkspaceDocumentPreview.tsx'
import type { ReadWorkspacePreview, ReadWorkspaceBytesPreview } from './components/WorkspaceFilePreview.tsx'
import type { ReadWorkspaceFileData } from './html/read-relative.ts'

/** Create readers sharing the application's existing connection pool.
 * @param connection - authorized base connection and target resolver.
 * @returns version-checked text and byte readers.
 */
export function createWorkspacePreviewReaders(connection: ConnectionHandle | undefined): {
  readDocument: ReadWorkspaceDocument
  readPreview: ReadWorkspacePreview
  readBytesPreview: ReadWorkspaceBytesPreview
  readFileBytes: ReadWorkspaceFileData
} {
  return {
    readDocument: async ({ resource, version, bytes }, signal) => {
      if (connection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace connection requires a live runtime')
      const { runtimeTarget, sessionId, path } = resource
      const target = runtimeTarget.kind === 'base' ? connection : connection.forTarget?.(runtimeTarget)
      if (target === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
      if (path.toLowerCase().endsWith('.pdf')) {
        if (bytes === undefined || bytes === 0) throw new Error('PDF preview requires a non-empty file with a known size.')
        const response = await target.api.workspaceFiles.readBytes({ sessionId, path, offset: 0, length: bytes, version }, signal)
        if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
        if (!response.result.value.eof) throw new Error('PDF preview requires the complete file contents.')
        return { version: response.result.value.version, bytes: response.result.value.bytes, missingFonts: [] }
      }
      const response = await target.api.workspaceFiles.renderOffice({ sessionId, path, version, priority: 'foreground' }, signal)
      if (!response.result.ok) {
        const error = response.result.error
        throw new WorkspaceResourceError(error.code === 'document-error' ? `office/${error.details.reason}` : error.code, error.message)
      }
      return response.result.value
    },
    readPreview: async (
      request: { resource: WorkspaceResourceOpenRequest; offset: number; version: string }, signal: AbortSignal,
    ) => {
      if (connection === undefined) throw new Error('Workspace file preview requires a connection')
      const { runtimeTarget, sessionId, path } = request.resource
      const targetConnection = runtimeTarget.kind === 'base'
        ? connection
        : connection.forTarget?.(runtimeTarget)
      if (targetConnection === undefined) {
        throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
      }
      const response = await targetConnection.api.workspaceFiles.read(
        { sessionId, path, offset: request.offset, version: request.version }, signal,
      )
      if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
      return response.result.value
    },
    readBytesPreview: async (
      request: { resource: WorkspaceResourceOpenRequest; offset: number; length: number; version: string }, signal: AbortSignal,
    ) => {
      if (connection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace connection requires a live runtime')
      const { runtimeTarget, sessionId, path } = request.resource
      const targetConnection = runtimeTarget.kind === 'base' ? connection : connection.forTarget?.(runtimeTarget)
      if (targetConnection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
      const response = await targetConnection.api.workspaceFiles.readBytes(
        { sessionId, path, offset: request.offset, length: request.length, version: request.version }, signal,
      )
      if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
      return response.result.value
    },
    readFileBytes: async (request, signal) => {
      if (connection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace connection requires a live runtime')
      const { runtimeTarget, sessionId, path } = request.resource
      const targetConnection = runtimeTarget.kind === 'base'
        ? connection
        : connection.forTarget?.(runtimeTarget)
      if (targetConnection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
      let version = request.version
      if (version === undefined) {
        const stat = await targetConnection.api.workspaceFiles.stat({ sessionId, path }, signal)
        if (!stat.result.ok) throw new WorkspaceResourceError(stat.result.error.code, stat.result.error.message)
        if (stat.result.value.type !== 'file') throw new WorkspaceResourceError('workspace-file/not-regular-file', 'Workspace path is not a regular file')
        version = stat.result.value.version
      }
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        signal.throwIfAborted()
        const response = await targetConnection.api.workspaceFiles.readBytes(
          { sessionId, path, offset: total, version }, signal,
        )
        if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
        const window = response.result.value
        const binary = atob(window.bytes)
        const chunk = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++) chunk[index] = binary.charCodeAt(index)
        chunks.push(chunk)
        total += chunk.byteLength
        if (window.eof) break
        if (chunk.byteLength === 0) throw new Error('Workspace byte window made no progress before EOF')
      }
      const data = new Uint8Array(total)
      let position = 0
      for (const chunk of chunks) {
        data.set(chunk, position)
        position += chunk.byteLength
      }
      return { data, version }
    },
  }
}
