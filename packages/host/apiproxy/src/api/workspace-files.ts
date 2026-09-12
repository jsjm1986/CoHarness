/**
 * Read-only Workspace file RPC contract. Paths are always relative to the
 * Session's registered workspace; host absolute paths never cross this API.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Lightweight file metadata returned by Workspace file operations. */
export interface WorkspaceFileStat {
  /** Canonical workspace-relative path using `/` separators. */
  path: string
  /** File kind; symlinks and special files are not exposed. */
  type: 'file' | 'directory'
  /** Byte size for regular files. */
  bytes?: number
  /** Opaque freshness token. */
  version: string
}

/** Direct child metadata returned by `workspaceFiles.list`. */
export interface WorkspaceFileEntry extends WorkspaceFileStat {
  /** Basename within the requested directory. */
  name: string
}

/** Bounded text page. Lines are one-based and the page never contains more than the configured byte bound. */
export interface WorkspaceFileTextPage {
  path: string
  offset: number
  limit: number
  text: string
  eof: boolean
  version: string
}

/** Bounded raw-byte window, encoded only at the wire boundary. */
export interface WorkspaceFileByteWindow {
  path: string
  offset: number
  bytes: string
  eof: boolean
  version: string
}

/** Read-only Workspace file methods. */
export interface WorkspaceFilesApi {
  /** List a bounded prefix of direct children without reading file content.
   * @param request - Session, relative directory (`.` by default), and optional entry limit.
   * @param signal - caller cancellation.
   * @returns relative child metadata and whether enumeration was truncated.
   */
  list(request: RpcRequest<{
    sessionId: SessionId
    path?: string
    maxEntries?: number
  }>, signal?: AbortSignal): Promise<RpcResponse<{
    path: string
    entries: WorkspaceFileEntry[]
    truncated: boolean
  }>>
  /** Read metadata without loading a Session body or activating an Agent.
   * @param request - Session and relative path.
   * @param signal - caller cancellation.
   * @returns metadata or a typed access/path error.
   */
  stat(request: RpcRequest<{ sessionId: SessionId; path: string }>, signal?: AbortSignal): Promise<RpcResponse<WorkspaceFileStat>>
  /** Read a UTF-8 line page; over-limit pages fail instead of silently truncating.
   * @param request - Session, relative file, one-based offset, line limit, and optional version guard.
   * @param signal - caller cancellation.
   * @returns text, page bounds, freshness token, and EOF status.
   */
  read(request: RpcRequest<{
    sessionId: SessionId
    path: string
    offset?: number
    limit?: number
    version?: string
  }>, signal: AbortSignal): Promise<RpcResponse<WorkspaceFileTextPage>>
  /** Read a raw byte window without UTF-8 decoding.
   * @param request - Session, relative file, zero-based offset, length, and optional version guard.
   * @param signal - caller cancellation.
   * @returns Base64 bytes, freshness token, and EOF status.
   */
  readBytes(request: RpcRequest<{
    sessionId: SessionId
    path: string
    offset?: number
    length?: number
    version?: string
  }>, signal: AbortSignal): Promise<RpcResponse<WorkspaceFileByteWindow>>
}
