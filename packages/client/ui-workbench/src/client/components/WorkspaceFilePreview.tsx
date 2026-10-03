/** Bounded read-only Workspace text preview, retaining content only in its view. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileTextPage } from '@deepseek-ai/dsh-api-remotes/client'
import { isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspacePreviewResource } from './WorkspaceFileTab.tsx'
import css from './Workbench.module.css'

/** Read one versioned page from the resource's explicit runtime. */
export type ReadWorkspaceBytesPreview = (
  request: { resource: WorkspaceResourceOpenRequest; offset: number; length: number; version: string },
  signal: AbortSignal,
) => Promise<import('@deepseek-ai/dsh-api-remotes/client').WorkspaceFileByteWindow>

export type ReadWorkspacePreview = (
  request: { resource: WorkspaceResourceOpenRequest; offset: number; version: string },
  signal: AbortSignal,
) => Promise<WorkspaceFileTextPage>

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
}
function imageMime(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase()
  /* v8 ignore next -- resource addresses reject empty paths before a preview mounts. */
  return extension === undefined ? undefined : IMAGE_MIME_BY_EXTENSION[extension]
}

/** Render one paginated file.
 * @param props - preview metadata/callbacks, readers, lifecycle, and labels.
 * @returns a read-only region inside its resource tab.
 */
export function WorkspaceFilePreview({ request, read, readBytes, resource, close, labels, initialLine }: {
  request: WorkspaceResourceOpenRequest
  initialLine?: number | undefined
  read: ReadWorkspacePreview
  readBytes?: ReadWorkspaceBytesPreview | undefined
  resource: WorkspacePreviewResource
  close: () => void
  labels: { close: string; reload: string; previous: string; next: string; loading: string; changed: string; binary: string }
}) {
  const { metadata, revoke } = resource
  const [offset, setOffset] = useState(initialLine ?? 1)
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<WorkspaceFileTextPage>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Error>()
  const [rawBytes, setRawBytes] = useState<string>()
  const [reloading, setReloading] = useState(false)
  const [source, setSource] = useState<{ version: string; bytes: number | undefined }>()
  const completed = useRef<string | undefined>(undefined)
  const denied = metadata.accessDenied || isWorkspaceAccessFailure(error)
  // A retained page or binary read keeps its own source version and size
  // estimate while the resource reports a changed successor, so a revalidation
  // publication cannot re-read the already displayed content.
  const retained = metadata.value?.changed === true && source !== undefined
  const version = retained ? source.version : metadata.value?.version
  const byteEstimate = retained ? source.bytes : metadata.value?.bytes
  useEffect(() => {
    if (denied) { setPage(undefined); setSource(undefined); completed.current = undefined; return }
    // The user's metadata reload owns this transition: while its stat is open,
    // the still-old snapshot cannot authorize a new content read.
    if (reloading) return
    if (version === undefined) return
    const key = `${version}:${String(offset)}:${String(revision)}`
    /* v8 ignore next -- a completed key is only revisited after a parent changes its reader identity. */
    if (completed.current === key) return
    const abort = new AbortController()
    const isCancelled = (): boolean => abort.signal.aborted
    setPending(true)
    setError(undefined)
    void read({ resource: request, offset, version }, abort.signal).then((value) => {
      if (isCancelled()) return
      completed.current = key
      setRawBytes(undefined)
      setPage(value)
      setSource({ version, bytes: byteEstimate })
    }, async (cause: unknown) => {
      if (isCancelled()) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      const code = (failure as { code?: unknown }).code
      if (code === 'workspace-file/not-text' && readBytes !== undefined && byteEstimate !== undefined) {
        try {
          const bytes = await readBytes({ resource: request, offset: 0, length: byteEstimate, version }, abort.signal)
          if (!isCancelled()) {
            setRawBytes(bytes.bytes)
            setSource({ version, bytes: byteEstimate })
            setError(undefined)
          }
          return
        } catch (byteCause: unknown) {
          if (isCancelled()) return
          const byteFailure = byteCause instanceof Error ? byteCause : new Error(String(byteCause))
          setError(byteFailure)
          if (isWorkspaceAccessFailure(byteFailure)) revoke(byteFailure.message)
          return
        }
      }
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) revoke(failure.message)
    }).finally(() => { if (!isCancelled()) setPending(false) })
    return () => { abort.abort() }
  }, [denied, version, request, offset, read, readBytes, revision, revoke, byteEstimate, reloading])
  const reload = async (): Promise<void> => {
    setReloading(true)
    try {
      await resource.reload()
      setError(undefined)
      setRawBytes(undefined)
      setSource(undefined)
      setRevision(value => value + 1)
    } finally {
      setReloading(false)
    }
  }
  const changed = metadata.value?.changed === true
  /* v8 ignore next -- CSS modules always provide this generated class in a built client. */
  const previewClass = css.filePreview ?? ''
  const message = error?.message ?? metadata.error?.message
  const imageType = imageMime(request.path)
  return (
    <section aria-label={request.path} className={previewClass}>
      <div className={css.filePreviewActions}>
        <Button size="sm" onClick={close}>{labels.close}</Button>
        <Button size="sm" disabled={pending || metadata.status === 'loading' || denied || reloading}
          onClick={() => { void reload() }}>{labels.reload}</Button>
        {page !== undefined && (
          <>
            <Button size="sm" disabled={pending || changed || denied || offset <= 1}
              onClick={() => { setOffset(value => Math.max(1, value - page.limit)) }}>
              {labels.previous}
            </Button>
            <Button size="sm" disabled={pending || changed || denied || page.eof}
              onClick={() => { setOffset(value => value + page.limit) }}>
              {labels.next}
            </Button>
          </>
        )}
      </div>
      {message !== undefined && <p role="alert">{message}</p>}
      {changed && !denied && <p role="status" data-workspace-file-changed>{labels.changed}</p>}
      {(pending || metadata.status === 'loading') && page === undefined && <p role="status">{labels.loading}</p>}
      {rawBytes !== undefined && imageType !== undefined && !denied && (
        <img className={css.filePreviewImage} src={`data:${imageType};base64,${rawBytes}`} alt={request.path}
          data-workspace-file-image />
      )}
      {rawBytes !== undefined && imageType === undefined && !denied && (
        <pre className={css.filePreviewText} data-workspace-file-bytes>
          {labels.binary}{'\n'}{rawBytes}
        </pre>
      )}
      {!denied && metadata.value !== undefined && page !== undefined && rawBytes === undefined && (
        <pre className={css.filePreviewText} data-workspace-file-preview>{page.text}</pre>
      )}
    </section>
  )
}
