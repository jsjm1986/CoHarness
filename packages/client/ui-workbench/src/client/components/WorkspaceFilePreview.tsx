/** Bounded read-only Workspace text preview, retaining content only in its view. */
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileTextPage } from '@deepseek-ai/dsh-api-remotes/client'
import { isWorkspaceAccessFailure } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { ZoomViewport, zoomSurfaceClass } from '../contract/zoom/ZoomViewport.tsx'
import { FIT_WIDTH, type ZoomLabels, type ZoomPreference } from '../contract/zoom/types.ts'
import type { WorkspacePreviewResource } from '../contract/preview/use-preview-read.ts'
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
export function WorkspaceFilePreview({ request, read, readBytes, resource, close, labels, zoomLabels, view, initialLine, nativeOpen }: {
  request: WorkspaceResourceOpenRequest
  initialLine?: number | undefined
  read: ReadWorkspacePreview
  readBytes?: ReadWorkspaceBytesPreview | undefined
  resource: WorkspacePreviewResource
  close: () => void
  /**
   * The authorized native-open gesture for a file the preview cannot render;
   * absent when the serving Host cannot open native paths (remote/Gateway).
   */
  nativeOpen?: (() => Promise<void>) | undefined
  labels: {
    close: string
    reload: string
    previous: string
    next: string
    loading: string
    changed: string
    binary: string
    /** Accessible name of the binary-fallback "open in the default application" action. */
    openNative: string
    /** Accessible name for the image preview of a decoded file name. */
    imageAlt: (name: string) => string
    /** Decode-failure copy for a supported image type. */
    imageFailed: string
  }
  zoomLabels: ZoomLabels
  /** Zoom preference belongs to the containing tab and survives a hidden preview. */
  view: { zoom?: ZoomPreference }
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
  const imageType = imageMime(request.path)
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
    // Image extensions read bytes directly: a text-readable payload such as SVG
    // must still render as an image, not as source text.
    const loadBytes = async (): Promise<void> => {
      if (readBytes === undefined || byteEstimate === undefined) return
      try {
        const bytes = await readBytes({ resource: request, offset: 0, length: byteEstimate, version }, abort.signal)
        if (isCancelled()) return
        setRawBytes(bytes.bytes)
        setPage(undefined)
        setSource({ version, bytes: byteEstimate })
        setError(undefined)
      } catch (byteCause: unknown) {
        if (isCancelled()) return
        const byteFailure = byteCause instanceof Error ? byteCause : new Error(String(byteCause))
        setError(byteFailure)
        if (isWorkspaceAccessFailure(byteFailure)) revoke(byteFailure.message)
      }
    }
    const settled = () => { if (!isCancelled()) setPending(false) }
    if (imageType !== undefined && readBytes !== undefined && byteEstimate !== undefined) {
      void loadBytes().finally(settled)
      return () => { abort.abort() }
    }
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
        await loadBytes()
        return
      }
      setError(failure)
      if (isWorkspaceAccessFailure(failure)) revoke(failure.message)
    }).finally(settled)
    return () => { abort.abort() }
  }, [denied, version, request, offset, read, readBytes, revision, revoke, byteEstimate, reloading, imageType])
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
  const [, bumpZoom] = useReducer((version: number) => version + 1, 0)
  const preference = view.zoom ?? FIT_WIDTH
  const lifetime = useMemo(() => new AbortController(), [])
  useEffect(() => () => { lifetime.abort() }, [lifetime])
  const setZoomPreference = (next: ZoomPreference): void => {
    view.zoom = next
    bumpZoom()
  }
  const image = rawBytes !== undefined && imageType !== undefined && !denied
  const zoomSection = image ? ` ${css.filePreviewZoom ?? ''}` : ''
  return (
    <section aria-label={request.path} className={previewClass + zoomSection}>
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
      {image && (
        <PreviewImage key={version ?? ''} path={request.path} bytes={rawBytes} mediaType={imageType}
          preference={preference} onPreference={setZoomPreference} labels={zoomLabels}
          status={labels.loading} failure={labels.imageFailed} alt={labels.imageAlt}
          signal={lifetime.signal} />
      )}
      {rawBytes !== undefined && imageType === undefined && !denied && (
        <>
          {nativeOpen !== undefined && (
            <div className={css.filePreviewActions}>
              <Button size="sm" onClick={() => {
                setError(undefined)
                void nativeOpen().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause : new Error(String(cause)))
                })
              }}>{labels.openNative}</Button>
            </div>
          )}
          <pre className={css.filePreviewText} data-workspace-file-bytes>
            {labels.binary}{'\n'}{rawBytes}
          </pre>
        </>
      )}
      {!denied && metadata.value !== undefined && page !== undefined && rawBytes === undefined && (
        <pre className={css.filePreviewText} data-workspace-file-preview>{page.text}</pre>
      )}
    </section>
  )
}

/** Decoded image bytes inside a shared zoom viewport at their intrinsic aspect ratio. */
function PreviewImage({ path, bytes, mediaType, preference, onPreference, labels, status, failure, alt, signal }: {
  readonly path: string
  readonly bytes: string
  readonly mediaType: string
  readonly preference: ZoomPreference
  readonly onPreference: (preference: ZoomPreference) => void
  readonly labels: ZoomLabels
  readonly status: string
  readonly failure: string
  readonly alt: (name: string) => string
  readonly signal: AbortSignal
}): ReactNode {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? path
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [width, setWidth] = useState<number>()
  return <ZoomViewport preference={preference} intrinsicWidth={width} horizontalInset={24}
    labels={labels} signal={signal} onPreference={onPreference}>
    <div className={css.filePreviewImageFrame} data-image-preview>
      {state === 'loading' && <p role="status">{status}</p>}
      {state === 'failed' && <p role="alert">{failure}</p>}
      <div className={`${css.filePreviewImageSurface} ${zoomSurfaceClass}`} data-document-zoom-surface
        style={{ '--document-zoom-width': `${width ?? 0}px` } as CSSProperties}
        hidden={state !== 'ready'}>
        <img className={css.filePreviewImage} src={`data:${mediaType};base64,${bytes}`} alt={alt(name)}
          data-workspace-file-image decoding="async" draggable={false} referrerPolicy="no-referrer"
          onLoad={(event) => { setWidth(event.currentTarget.naturalWidth); setState('ready') }}
          onError={() => { setState('failed') }} />
      </div>
    </div>
  </ZoomViewport>
}
