/** Entry for opening the document manager without loading its body during Web startup. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentsModal, DocumentsModalProps } from './DocumentsModal.tsx'

type View =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; Body: typeof DocumentsModal }

/** Keep short requests from flashing a separate loading dialog. */
const LOADING_DIALOG_DELAY_MS = 240

/**
 * Prepare the same revisioned manager chunk used by a picker request.
 */
export function preloadDocumentsModal(): void {
  if (document.hidden) return
  void import('./DocumentsModal.tsx').catch(() => {
    // A failed speculative load leaves the picker free to request the chunk on demand.
  })
}

/**
 * Deduplicate requests from one document surface and retain the resolved component.
 * @returns the current load state and a command to start or retry loading.
 */
export function useDocumentsModalLoad() {
  const [view, setView] = useState<View>({ kind: 'loading' })
  const requested = useRef(false)
  const load = useCallback(() => {
    if (requested.current) return
    requested.current = true
    setView(previous => previous.kind === 'failed' ? { kind: 'loading' } : previous)
    void import('./DocumentsModal.tsx').then(({ DocumentsModal: Body }) => {
      setView({ kind: 'ready', Body })
    }, () => {
      requested.current = false
      setView({ kind: 'failed' })
    })
  }, [])
  return { view, load }
}

function OpeningFeedback({ failed, onClose, onRetry, t }: Pick<DocumentsModalProps, 'onClose' | 't'> & {
  failed: boolean
  onRetry: () => void
}): ReactNode {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => { setVisible(true) }, LOADING_DIALOG_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [])
  if (!visible && !failed) return null
  return (
    <Modal open onClose={onClose} title={t('modal.title')} closeLabel={t('modal.close')}
      footer={failed
        ? <Button variant="outline" onClick={() => { setVisible(true); onRetry() }}>{t('scope.retry')}</Button>
        : undefined}>
      {failed
        ? <p role="alert">{t('modal.open.error')}</p>
        : <p role="status">{t('modal.loading')}</p>}
    </Modal>
  )
}

/**
 * Render the result of a load started by the picker host.
 * @param props - the manager props and the host-owned load state.
 * @returns the manager dialog or feedback for an incomplete load.
 */
export function DocumentsModalView({ loader, ...props }: DocumentsModalProps & {
  loader: ReturnType<typeof useDocumentsModalLoad>
}): ReactNode {
  const { view, load } = loader
  if (view.kind === 'ready') return <view.Body {...props} />
  if (!props.open) return null
  return <OpeningFeedback failed={view.kind === 'failed'} onClose={props.onClose} onRetry={load} t={props.t} />
}

/**
 * Load the document manager for consumers that control its open prop.
 * @param props - document manager state, locale and captured attachment target.
 * @returns the manager dialog or feedback for an incomplete load.
 */
export function DeferredDocumentsModal(props: DocumentsModalProps): ReactNode {
  const loader = useDocumentsModalLoad()
  const { load } = loader
  useEffect(() => {
    if (props.open) load()
  }, [props.open, load])
  return <DocumentsModalView {...props} loader={loader} />
}
