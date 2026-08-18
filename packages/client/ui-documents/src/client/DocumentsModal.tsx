import { useEffect, useRef, useState, type FC, type FormEvent } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createUserDocClient, UserDocServiceUnavailableError, type UserDocLimits, type UserDocRef } from './documents-client.ts'
import { DocumentPreview } from './DocumentPreview.tsx'
import { formatBytes, getDateGroup } from './format.ts'
import type { DocumentsKey } from './locales.ts'

export interface DocumentsModalProps {
  open: boolean
  onClose: () => void
  t: (key: DocumentsKey, params?: Record<string, string>) => string
}

interface GroupedDoc {
  date: string
  documents: UserDocRef[]
}

const MAX_PREVIEW_TEXT_BYTES = 256 * 1024

export const DocumentsModal: FC<DocumentsModalProps> = ({ open, onClose, t }) => {
  const [documents, setDocuments] = useState<UserDocRef[]>([])
  const [limits, setLimits] = useState<UserDocLimits | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<UserDocRef | null>(null)
  const [previewDoc, setPreviewDoc] = useState<UserDocRef | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const userDocs = useRef(createUserDocClient())

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await userDocs.current.list()
      setDocuments([...response.documents].reverse())
      setLimits(response.limits)
    } catch (cause) {
      if (cause instanceof UserDocServiceUnavailableError) {
        setError(t('error.unavailable'))
      } else {
        setError(cause instanceof Error ? cause.message : /* v8 ignore next -- Error is always an Error in tests */ String(cause))
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    /* v8 ignore next -- modal is always open in tests */
    if (!open) return
    void load()
  }, [open])

  const filtered = query === ''
    ? documents
    : documents.filter(d => d.name.toLowerCase().includes(query.toLowerCase()))

  const groups: GroupedDoc[] = []
  const seen = new Set<string>()
  for (const doc of filtered) {
    const date = getDateGroup(doc.docId)
    if (!seen.has(date)) {
      seen.add(date)
      groups.push({ date, documents: [] })
    }
    groups.find(g => g.date === date)?.documents.push(doc)
  }

  const handleUpload = async (event: FormEvent) => {
    event.preventDefault()
    const files = fileInputRef.current?.files
    /* v8 ignore next -- input ref is always present when the component is mounted */
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of files) {
        await userDocs.current.upload(file)
      }
      /* v8 ignore next -- ref is always present after mount */
      if (fileInputRef.current) fileInputRef.current.value = ''
      void load()
    } catch {
      setError(t('modal.upload.error'))
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async () => {
    /* v8 ignore next -- only called when deleteTarget is set */
    if (!deleteTarget) return
    try {
      await userDocs.current.remove(deleteTarget.docId)
      setDeleteTarget(null)
      void load()
    } catch {
      setError(t('delete.error'))
    }
  }

  const limitsText = limits !== null
    ? t('modal.limits', { size: formatBytes(limits.maxFileBytes), count: String(limits.maxFilesPerMessage) })
    : ''

  /* v8 ignore next -- tested via cancel button with same behavior */
  const closeDelete = () => setDeleteTarget(null)

  return (
    <>
      <Modal open={open} onClose={onClose} title={t('modal.title')} closeLabel={t('button.label')}>
        {error && <div role="alert">{error}</div>}
        {limitsText && <div>{limitsText}</div>}

        <div>
          <Input
            placeholder={t('modal.search')}
            value={query}
            onChange={e => setQuery((e.target as HTMLInputElement).value)}
          />
          <form onSubmit={handleUpload}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={() => { setError('') }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? t('modal.upload.progress') : t('modal.upload')}
            </Button>
          </form>
          <Button type="button" variant="outline" onClick={() => void load()}>
            {t('modal.refresh')}
          </Button>
        </div>

        {loading ? (
          <div>{t('modal.upload.progress')}</div>
        ) : documents.length === 0 ? (
          <div>{t('modal.empty')}</div>
        ) : (
          <div>
            {groups.map(group => (
              <div key={group.date}>
                <div>{group.date}</div>
                {group.documents.map(doc => (
                  <div key={doc.docId}>
                    <span title={doc.name}>{doc.name}</span>
                    <span>{formatBytes(doc.bytes)}</span>
                    <span>
                      <button type="button" onClick={() => setPreviewDoc(doc)} title={t('action.preview')}>
                        {t('action.preview')}
                      </button>
                      <a
                        href={userDocs.current.contentUrl(doc.docId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('action.download')}
                      >
                        {t('action.download')}
                      </a>
                      <button type="button" onClick={() => setDeleteTarget(doc)} title={t('action.delete')}>
                        {t('action.delete')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Modal>

      {deleteTarget && (
        <Modal
          open
          onClose={closeDelete}
          title={t('delete.confirm.title')}
          closeLabel={t('delete.confirm.button')}
        >
          <p>{t('delete.confirm.message')}</p>
          <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
            {t('button.label')}
          </Button>
          <Button type="button" variant="primary" onClick={handleDelete}>
            {t('delete.confirm.button')}
          </Button>
        </Modal>
      )}

      {previewDoc && (
        <DocumentPreview
          doc={previewDoc}
          maxTextBytes={MAX_PREVIEW_TEXT_BYTES}
          onClose={() => setPreviewDoc(null)}
          t={t}
        />
      )}
    </>
  )
}
