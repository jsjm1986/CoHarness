/** Versioned content read shared by the workspace document, spreadsheet, HTML, and Markdown previews. */
import { useEffect, useMemo, useState } from 'react'
import { isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest, WorkspaceResourceState, WorkspaceResourceValue } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * The plain metadata/callback face every preview reads. The subscription lives
 * in the tab's framework hook; children see JSON-compatible facts and bound
 * callbacks, never the registry or the raw source.
 */
export interface WorkspacePreviewResource {
  metadata: {
    status: WorkspaceResourceState['status']
    value?: WorkspaceResourceValue
    error?: { message: string; code?: string }
    accessDenied: boolean
  }
  /** Reload metadata; true only when the source published live metadata. */
  reload: () => Promise<boolean>
  revoke: (message: string) => void
}

/** Localized actions and reports for both stream recovery and a failed HTTP request. */
export interface WorkspacePreviewActionLabels {
  close: string
  reload: string
  reconnecting: string
  reloadFailed: string
  requestFailed: string
  requestFailedRetained: string
}

/** The read state and commands a preview derives from the shared lifecycle. */
export interface WorkspacePreviewRead<R> {
  /** The same request's last completed read, retained during reload and non-access failures. */
  result: R | undefined
  /** Displayed content predates the latest published metadata or a change observation. */
  changed: boolean
  /** The last read failure normalized to `Error`; access failures also revoke the resource. */
  error: Error | undefined
  /** A content read is in flight. */
  pending: boolean
  /** A user-requested metadata reload is in flight; the next read waits for its stat. */
  reloading: boolean
  /** Published metadata or the last read failure denies access. */
  denied: boolean
  /** Cancellation covering this mounted preview: aborts on unmount, a new request, or a denial. */
  lifetime: AbortController
  /** Reload metadata through the owning resource, then re-read the published version. */
  reload: () => Promise<void>
}

/**
 * Run one content read per published resource version without a second subscription.
 * A completed read retains its own input while the resource reports a changed
 * successor, so a revalidation publication cannot re-read or re-version the
 * already displayed content. A successful metadata reload starts a fresh read;
 * a failed stat starts no content read. Failed reads retain the last result with
 * their report and any version-change notice. Revocation withdraws it immediately.
 * @param args - the tab's request and resource face, the fresh read input derived
 *   from published metadata (`undefined` waits for a version), and the read itself.
 * @returns the retained result, failure and denial facts, the lifetime signal, and reload.
 */
export function useWorkspacePreviewRead<I, R>(args: {
  request: WorkspaceResourceOpenRequest
  resource: WorkspacePreviewResource
  input: I | undefined
  read: (input: I, signal: AbortSignal) => Promise<R>
}): WorkspacePreviewRead<R> {
  const { request, resource, input, read } = args
  const { metadata, revoke } = resource
  const [completed, setCompleted] = useState<{
    request: WorkspaceResourceOpenRequest
    input: I
    result: R
    version: string | undefined
    attempt: number
    read: typeof read
  }>()
  const [failure, setFailure] = useState<{ request: WorkspaceResourceOpenRequest; error: Error }>()
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [reloadRequest, setReloadRequest] = useState<WorkspaceResourceOpenRequest>()
  const reloading = reloadRequest === request
  const error = failure?.request === request ? failure.error : undefined
  const visible = completed?.request === request ? completed : undefined
  const denied = metadata.accessDenied || isWorkspaceAccessFailure(error)
  const retained = metadata.value?.changed === true && visible?.attempt === attempt
  const effective = retained ? visible.input : input
  const version = metadata.value?.version
  const lifetime = useMemo(() => new AbortController(), [request, denied])
  useEffect(() => () => { lifetime.abort() }, [lifetime])
  useEffect(() => {
    if (denied) { setCompleted(undefined); setPending(false); return }
    // The user's metadata reload owns this transition: while its stat is open,
    // the still-old snapshot cannot authorize a new content read.
    if (reloading || metadata.status !== 'live' || effective === undefined
      || (visible?.input === effective && visible.attempt === attempt && visible.read === read)) {
      setPending(false)
      return
    }
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, lifetime.signal])
    setPending(true)
    setFailure(undefined)
    void read(effective, signal).then((value) => {
      if (!signal.aborted) setCompleted({ request, input: effective, result: value, version, attempt, read })
    }, (cause: unknown) => {
      if (signal.aborted) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      setFailure({ request, error: failure })
      if (isWorkspaceAccessFailure(failure)) revoke(failure.message)
    }).finally(() => { if (!signal.aborted) setPending(false) })
    return () => { abort.abort() }
  }, [read, effective, attempt, denied, lifetime, reloading, revoke, metadata.status, visible, request, version])
  const reload = async (): Promise<void> => {
    setReloadRequest(request)
    setFailure(undefined)
    try {
      const live = await resource.reload()
      if (!live || lifetime.signal.aborted) return
      setAttempt(value => value + 1)
    } finally {
      setReloadRequest(current => current === request ? undefined : current)
    }
  }
  return { result: denied ? undefined : visible?.result,
    changed: visible !== undefined && (metadata.value?.changed === true || visible.version !== version),
    error, pending, reloading, denied, lifetime, reload }
}
