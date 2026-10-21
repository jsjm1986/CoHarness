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
  reload: () => Promise<void>
  revoke: (message: string) => void
}

/** The read state and commands a preview derives from the shared lifecycle. */
export interface WorkspacePreviewRead<R> {
  /** The last completed read; `undefined` while idle, denied, or failed. */
  result: R | undefined
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
 * already displayed content; the user's metadata reload clears the retention.
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
  const [completed, setCompleted] = useState<{ input: I; result: R }>()
  const [error, setError] = useState<Error>()
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [reloading, setReloading] = useState(false)
  const denied = metadata.accessDenied || isWorkspaceAccessFailure(error)
  const retained = metadata.value?.changed === true && completed !== undefined
  const effective = retained ? completed.input : input
  const lifetime = useMemo(() => new AbortController(), [request, denied])
  useEffect(() => () => { lifetime.abort() }, [lifetime])
  useEffect(() => {
    if (denied) { setCompleted(undefined); return }
    // The user's metadata reload owns this transition: while its stat is open,
    // the still-old snapshot cannot authorize a new content read.
    if (reloading) return
    if (effective === undefined) return
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, lifetime.signal])
    setPending(true)
    setError(undefined)
    void read(effective, signal).then((value) => {
      if (!signal.aborted) setCompleted({ input: effective, result: value })
    }, (cause: unknown) => {
      if (signal.aborted) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      setCompleted(undefined)
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) revoke(failure.message)
    }).finally(() => { if (!signal.aborted) setPending(false) })
    return () => { abort.abort() }
  }, [read, effective, attempt, denied, lifetime, reloading, revoke])
  const reload = async (): Promise<void> => {
    setReloading(true)
    try {
      await resource.reload()
      setError(undefined)
      setCompleted(undefined)
      setAttempt(value => value + 1)
    } finally {
      setReloading(false)
    }
  }
  return { result: completed?.result, error, pending, reloading, denied, lifetime, reload }
}
