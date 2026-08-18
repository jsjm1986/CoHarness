import { useEffect, useState, type FC } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createUserDocClient, type UserDocRef } from './documents-client.ts'
import type { DocumentsKey } from './locales.ts'

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
    <Modal open onClose={onClose} title={t('preview.title', { name: doc.name })} closeLabel={t('action.preview')}>
      <div>
        {state === 'loading' && <div>{t('modal.upload.progress')}</div>}
        {state === 'too-large' && <div>{t('preview.too.large')}</div>}
        {state === 'unsupported' && <div>{t('preview.not.supported')}</div>}
        {state === 'ready' && classifyMediaType(doc.mediaType) === 'image' && (
          <img src={contentUrl} alt={doc.name} />
        )}
        {state === 'ready' && classifyMediaType(doc.mediaType) === 'pdf' && (
          <iframe src={contentUrl} title={doc.name} />
        )}
        {state === 'ready' && classifyMediaType(doc.mediaType) === 'text' && (
          <pre>{textContent}</pre>
        )}
      </div>
    </Modal>
  )
}
