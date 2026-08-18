import { useEffect, useState, type FC } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createUserDocClient, type UserDocRef } from './documents-client.ts'
import type { DocumentsKey } from './locales.ts'
import css from './DocumentPreview.module.css'

export interface DocumentPreviewProps {
  doc: UserDocRef
  maxTextBytes: number
  onClose: () => void
  t: (key: DocumentsKey, params?: Record<string, string>) => string
}

type PreviewState = 'loading' | 'too-large' | 'unsupported' | 'ready'

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
export const DocumentPreview: FC<DocumentPreviewProps> = ({ doc, maxTextBytes, onClose, t }) => {
  const [state, setState] = useState<PreviewState>('loading')
  const [textContent, setTextContent] = useState('')
  const [userDocs] = useState(() => createUserDocClient())

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
    fetch(userDocs.contentUrl(doc.docId), { signal: controller.signal })
      .then(res => res.text())
      .then((text) => {
        setTextContent(text)
        setState('ready')
      })
      .catch(() => { setState('unsupported') })
    return () => { controller.abort() }
  }, [doc.docId, doc.bytes, doc.mediaType, maxTextBytes, userDocs])

  const contentUrl = userDocs.contentUrl(doc.docId)

  return (
    <Modal
      open
      onClose={onClose}
      title={t('preview.title', { name: doc.name })}
      closeLabel={t('modal.close')}
      className={css.dialog ?? ''}
      contentClassName={css.shell ?? ''}
    >
      <div className={css.body}>
        {state === 'loading' && <p className={css.status}>{t('modal.loading')}</p>}
        {state === 'too-large' && <p className={css.status}>{t('preview.too.large')}</p>}
        {state === 'unsupported' && <p className={css.status}>{t('preview.not.supported')}</p>}
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
