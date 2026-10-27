import { useEffect, useRef, useState, type FC, type ReactNode } from 'react'
import { Button, IconChevronLeftOutline14, IconCloseOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ApiResponseTooLargeError, readApiResponseText } from '@deepseek-ai/dsh-client-runtime/client'
import { createUserDocClient, type UserDocRef, type UserDocScope } from './documents-client.ts'
import { FileTypeIcon } from './FileTypeIcon.tsx'
import { formatBytes, getDateGroup } from './format.ts'
import type { DocumentsKey } from './locales.ts'
import css from './DocumentPreview.module.css'

export interface DocumentPreviewProps {
  /** Bind authenticated image, iframe and download navigations to their current account. */
  privateResourceUrl?: ((url: string) => string) | undefined
  doc: UserDocRef
  /** Render alongside the manager list instead of opening a second modal. */
  embedded?: boolean
  /** Safe display label for the document's browsing scope. */
  sourceLabel?: string
  /** Existing manager actions, fixed below the media scrollport. */
  actions?: ReactNode
  /** Optional explicit scope when previewing a non-current project. */
  scope?: UserDocScope | undefined
  maxTextBytes: number
  onClose: () => void
  t: (key: DocumentsKey, params?: Record<string, string>) => string
}

type PreviewState = 'loading' | 'too-large' | 'unsupported' | 'ready'

async function readPreviewText(response: Response, maxBytes: number): Promise<string> {
  return readApiResponseText(response, maxBytes)
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
 * @returns an inline reading region or media dialog, with a download fallback.
 */
export const DocumentPreview: FC<DocumentPreviewProps> = ({
  doc, scope, maxTextBytes, onClose, t, privateResourceUrl, embedded = false, sourceLabel, actions,
}) => {
  const readingPosition = useRef({ id: doc.docId, top: 0 })
  const [state, setState] = useState<PreviewState>('loading')
  const [textContent, setTextContent] = useState('')
  const [userDocs] = useState(() => createUserDocClient())
  const contentAddress = (inline: boolean): string => {
    if (scope === undefined) return userDocs.contentUrl(doc.docId, inline)
    const scoped = (userDocs as unknown as {
      scopedContentUrl?: (target: UserDocScope, id: UserDocRef['docId'], inline?: boolean) => string
    }).scopedContentUrl
    return typeof scoped === 'function' ? scoped(scope, doc.docId, inline) : userDocs.contentUrl(doc.docId, inline)
  }

  const scopedUrl = (inline: boolean): string => { const url = contentAddress(inline); return privateResourceUrl?.(url) ?? url }

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
        setState(error instanceof ApiResponseTooLargeError ? 'too-large' : 'unsupported')
      })
    return () => { controller.abort() }
  }, [doc.docId, doc.bytes, doc.mediaType, maxTextBytes, scope, userDocs, privateResourceUrl])

  const contentUrl = scopedUrl(true)

  const surface = <section className={css.surface} data-document-preview="">
    <header className={css.header}>
      {!embedded && <Button type="button" className={css.close} variant="ghost" aria-label={t('preview.back')} data-modal-autofocus onClick={onClose}><IconChevronLeftOutline14 size={18} /></Button>}
      <FileTypeIcon name={doc.name} mediaType={doc.mediaType} className={css.fileTypeIcon} />
      <div className={css.heading}><h3>{doc.name}</h3>{sourceLabel !== undefined && <p>{t('preview.source', { name: sourceLabel })}</p>}<p>{formatBytes(doc.bytes)} · {getDateGroup(doc.modifiedAt, t('date.unknown'))}</p></div>
      {embedded && <Button type="button" className={css.close} variant="ghost" aria-label={t('preview.close')} onClick={onClose}><IconCloseOutline16 size={16} /></Button>}
    </header>
    <div className={css.body} ref={(element) => {
      if (readingPosition.current.id !== doc.docId) readingPosition.current = { id: doc.docId, top: 0 }
      if (element !== null) element.scrollTop = readingPosition.current.top
    }} onScroll={(event) => { readingPosition.current = { id: doc.docId, top: event.currentTarget.scrollTop } }}>
      {state === 'loading' && <div className={css.loading} role="status" aria-label={t('modal.loading')}><span /><span /><span /></div>}
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
    {actions !== undefined && <footer className={css.actions}>{actions}</footer>}
  </section>
  if (embedded) return <aside className={css.inline} aria-label={t('preview.title', { name: doc.name })}>{surface}</aside>
  return <Modal open onClose={onClose} title={t('preview.title', { name: doc.name })} headless className={css.dialog as string}>{surface}</Modal>
}
