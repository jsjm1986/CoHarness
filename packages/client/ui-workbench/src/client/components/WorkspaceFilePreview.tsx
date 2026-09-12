/** Bounded read-only Workspace text preview, retaining content only in its view. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileTextPage } from '@deepseek-ai/dsh-api-remotes/client'
import { WorkspaceResourceError, isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceRegistry, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
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

/** Render one paginated file. @param props - bound resource, reader, lifecycle, and labels. @returns a read-only preview dialog. */
export function WorkspaceFilePreview({ request, read, readBytes, resources, close, labels }: {
  request: WorkspaceResourceOpenRequest
  read: ReadWorkspacePreview
  readBytes?: ReadWorkspaceBytesPreview | undefined
  resources: WorkspaceResourceRegistry
  close: () => void
  labels: { close: string; reload: string; previous: string; next: string; loading: string; changed: string; binary: string }
}) {
  const source = useMemo(() => resources.source(request), [resources, request])
  const state = useSyncExternalStore(source.subscribe, source.get, source.get)
  const [offset, setOffset] = useState(1)
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<WorkspaceFileTextPage>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Error>()
  const [rawBytes, setRawBytes] = useState<string>()
  const completed = useRef<string | undefined>(undefined)
  const denied = isWorkspaceAccessFailure(state.error) || isWorkspaceAccessFailure(error)
  const version = state.value?.changed === true && page !== undefined ? page.version : state.value?.version
  useEffect(() => {
    if (denied) { setPage(undefined); completed.current = undefined; return }
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
    }, async (cause: unknown) => {
      if (isCancelled()) return
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      const code = (failure as { code?: unknown }).code
      if (code === 'workspace-file/not-text' && readBytes !== undefined && state.value?.bytes !== undefined) {
        try {
          const bytes = await readBytes({ resource: request, offset: 0, length: state.value.bytes, version }, abort.signal)
          if (!isCancelled()) { setRawBytes(bytes.bytes); setError(undefined) }
          return
        } catch (byteCause: unknown) {
          if (isCancelled()) return
          const byteFailure = byteCause instanceof Error ? byteCause : new Error(String(byteCause))
          setError(byteFailure)
          if (isWorkspaceAccessFailure(byteFailure)) resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', byteFailure.message))
          return
        }
      }
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', failure.message))
    }).finally(() => { if (!isCancelled()) setPending(false) })
    return () => { abort.abort() }
  }, [denied, version, request, offset, read, readBytes, revision, resources, state.value?.bytes])
  const reload = async (): Promise<void> => {
    setError(undefined)
    setRawBytes(undefined)
    await source.reload()
    setRevision(value => value + 1)
  }
  const changed = state.value?.changed === true
  /* v8 ignore next -- CSS modules always provide this generated class in a built client. */
  const previewClass = css.filePreview ?? ''
  const message = error?.message ?? state.error?.message
  const imageType = imageMime(request.path)
  return (
    <Modal open title={request.path} closeLabel={labels.close} onClose={close}
      className={previewClass}
      footer={(
        <>
          <Button size="sm" disabled={pending || state.status === 'loading' || denied}
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
        </>
      )}>
      {message !== undefined && <p role="alert">{message}</p>}
      {changed && !denied && <p role="status" data-workspace-file-changed>{labels.changed}</p>}
      {(pending || state.status === 'loading') && page === undefined && <p role="status">{labels.loading}</p>}
      {rawBytes !== undefined && imageType !== undefined && !denied && (
        <img className={css.filePreviewImage} src={`data:${imageType};base64,${rawBytes}`} alt={request.path}
          data-workspace-file-image />
      )}
      {rawBytes !== undefined && imageType === undefined && !denied && (
        <pre className={css.filePreviewText} data-workspace-file-bytes>
          {labels.binary}\n{rawBytes}
        </pre>
      )}
      {!denied && state.value !== undefined && page !== undefined && rawBytes === undefined && (
        <pre className={css.filePreviewText} data-workspace-file-preview>{page.text}</pre>
      )}
    </Modal>
  )
}
