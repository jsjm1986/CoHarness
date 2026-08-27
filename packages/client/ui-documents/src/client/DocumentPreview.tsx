import { useEffect, useState, type FC } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createUserDocClient, type UserDocRef, type UserDocScope } from './documents-client.ts'
import type { DocumentsKey } from './locales.ts'
import css from './DocumentPreview.module.css'

export interface DocumentPreviewProps {
  doc: UserDocRef
  /** Optional explicit scope when previewing a non-current project. */
  scope?: UserDocScope | undefined
  maxTextBytes: number
  onClose: () => void
  t: (key: DocumentsKey, params?: Record<string, string>) => string
}

type PreviewState = 'loading' | 'too-large' | 'unsupported' | 'ready'

class PreviewTooLargeError extends Error {}

async function readPreviewText(response: Response, maxBytes: number): Promise<string> {
  const headers = (response as unknown as { headers?: { get?: (name: string) => string | null } }).headers
  const declared = Number(headers?.get?.('content-length') ?? '')
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    await (response as unknown as { body?: ReadableStream<Uint8Array> | null }).body?.cancel()
    throw new PreviewTooLargeError()
  }
  const body = (response as unknown as { body?: ReadableStream<Uint8Array> | null }).body
  if (body === null || body === undefined) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new PreviewTooLargeError()
    return text
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new PreviewTooLargeError()
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function classifyMediaType(mediaType: string): 'image' | 'pdf' | 'text' | 'unsupported' {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType === 'application/xml'
    || mediaType === 'application/x-yaml'
    || mediaType === 'application/javascript'
    || mediaType.endsWith('+json')
    || mediaType.endsWith('+xml')
  ) return 'text'
  return 'unsupported'
}

/**
 * Media preview dialog for one stored document.
 * @param props.doc - document to preview.
 * @param props.maxTextBytes - text files larger than this show the download fallback.
 * @param props.onClose - dismiss the preview.
 * @param props.t - localized documents dictionary.
 * @returns a dialog with image, PDF, text, or a fallback message.
 */
export const DocumentPreview: FC<DocumentPreviewProps> = ({ doc, scope, maxTextBytes, onClose, t }) => {
  const [state, setState] = useState<PreviewState>('loading')
  const [textContent, setTextContent] = useState('')
  const [userDocs] = useState(() => createUserDocClient())
  const scopedUrl = (inline: boolean): string => {
    if (scope === undefined) return userDocs.contentUrl(doc.docId, inline)
    const scoped = (userDocs as unknown as {
      scopedContentUrl?: (target: UserDocScope, id: UserDocRef['docId'], inline?: boolean) => string
    }).scopedContentUrl
    return typeof scoped === 'function' ? scoped(scope, doc.docId, inline) : userDocs.contentUrl(doc.docId, inline)
  }

  useEffect(() => {
    const type = classifyMediaType(doc.mediaType)
    if (type === 'image' || type === 'pdf' || type === 'unsupported') {
      setState(type === 'unsupported' ? 'unsupported' : 'ready')
      return
    }
    if (doc.bytes > maxTextBytes) {
      setState('too-large')
      return
    }
    const controller = new AbortController()
    setState('loading')
    const url = scopedUrl(true)
    fetch(url, { signal: controller.signal })
      .then((res) => {
        const ok = (res as unknown as { ok?: boolean }).ok
        if (ok === false) throw new Error(`preview request failed: ${String((res as unknown as { status?: unknown }).status)}`)
        return readPreviewText(res, maxTextBytes)
      })
      .then((text) => {
        if (controller.signal.aborted) return
        setTextContent(text)
        setState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState(error instanceof PreviewTooLargeError ? 'too-large' : 'unsupported')
      })
    return () => { controller.abort() }
  }, [doc.docId, doc.bytes, doc.mediaType, maxTextBytes, scope, userDocs])

  const contentUrl = scopedUrl(true)

  return (
    <Modal
      open
      onClose={onClose}
      title={t('preview.title', { name: doc.name })}
      closeLabel={t('modal.close')}
      className={css.dialog as string}
      contentClassName={css.shell as string}
    >
      <div className={css.body}>
        {state === 'loading' && <p className={css.status}>{t('modal.loading')}</p>}
        {state === 'too-large' && <>
          <p className={css.status}>{t('preview.too.large')}</p>
          <a className={css.download} href={scopedUrl(false)} target="_blank" rel="noopener noreferrer">{t('preview.download')}</a>
        </>}
        {state === 'unsupported' && <>
          <p className={css.status}>{t('preview.not.supported')}</p>
          <a className={css.download} href={scopedUrl(false)} target="_blank" rel="noopener noreferrer">{t('preview.download')}</a>
        </>}
        {state === 'ready' && classifyMediaType(doc.mediaType) === 'image' && (
          <img className={css.image} src={contentUrl} alt={doc.name} />
        )}
        {state === 'ready' && classifyMediaType(doc.mediaType) === 'pdf' && (
          <iframe className={css.frame} src={contentUrl} title={doc.name} />
        )}
        {state === 'ready' && classifyMediaType(doc.mediaType) === 'text' && (
          <pre className={css.text}>{textContent}</pre>
        )}
      </div>
    </Modal>
  )
}
