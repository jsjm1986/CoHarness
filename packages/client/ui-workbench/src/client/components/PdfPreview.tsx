/** HTTP document reader sharing the workbench's lazy PDF body and zoom controls. */
import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { readApiResponseBytes } from '@deepseek-ai/dsh-client-runtime/client'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { PdfPreviewInput } from '../contract/pdf-preview.ts'
import { usePreviewViewer } from '../contract/preview/use-preview-viewer.ts'
import { ZoomViewport, zoomSurfaceClass } from '../contract/zoom/ZoomViewport.tsx'
import type { ZoomPreference } from '../contract/zoom/types.ts'
import css from './PdfPreview.module.css'

const loadPdfBody = async () => ({ default: (await import('../pdf/pdf.tsx')).PdfBody })
type PdfPreviewProps = Pick<FactoryComponentPropsOf<'document.pdf.preview'>, keyof PdfPreviewInput | 't'>
type ReadState = { readonly kind: 'loading' } | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly data: Uint8Array<ArrayBuffer>; readonly signal: AbortSignal }

/**
 * Read complete bounded bytes before starting the existing PDF Worker.
 * @param props - authorized address, content identity, byte budget and PDF locale.
 * @returns an independent reader whose requests and renderers stop on replacement or unmount.
 */
export function PdfPreview({ sourceUrl, documentKey, maxBytes, t }: PdfPreviewProps): ReactNode {
  return <PdfRead key={JSON.stringify([documentKey, sourceUrl, maxBytes])} sourceUrl={sourceUrl} maxBytes={maxBytes} t={t} />
}

function PdfRead({ sourceUrl, maxBytes, t }: Omit<PdfPreviewProps, 'documentKey'>): ReactNode {
  const [state, setState] = useState<ReadState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [view] = useState<{ page: number; zoom?: ZoomPreference }>(() => ({ page: 1 }))
  const PdfBody = usePreviewViewer(loadPdfBody, maxBytes > 0)
  useEffect(() => {
    if (maxBytes === 0) return
    const lifetime = new AbortController()
    const signal = lifetime.signal
    setState({ kind: 'loading' })
    void (async () => {
      const response = await fetch(sourceUrl, { signal })
      if (!response.ok) throw new Error('PDF content request failed')
      const data = await readApiResponseBytes(response, maxBytes, signal)
      signal.throwIfAborted()
      if (data.byteLength === 0) throw new Error('PDF content is empty')
      setState({ kind: 'ready', data, signal })
    })().catch(() => {
      if (!signal.aborted) {
        setState({ kind: 'failed' })
        lifetime.abort()
      }
    })
    return () => { lifetime.abort() }
  }, [sourceUrl, maxBytes, attempt])

  const loading = <div className={css.status} role="status">{t('loading')}</div>
  return <div className={css.root} data-document-pdf-reader>
    {maxBytes === 0 || state.kind === 'failed'
      ? <div className={css.status} role="alert">
        <span>{t('unsupported')}</span>
        {maxBytes > 0 && <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>}
      </div>
      : state.kind === 'loading' ? loading
        : <Suspense fallback={loading}>
          <PdfBody data={state.data} signal={state.signal} t={t} view={view}
            ZoomViewport={ZoomViewport} zoomSurfaceClass={zoomSurfaceClass} />
        </Suspense>}
  </div>
}
