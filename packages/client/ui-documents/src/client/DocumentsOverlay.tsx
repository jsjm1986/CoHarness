/** Root document-picker host, independent of sidebar and pane lifetimes. */
import { useCallback, useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DocumentsButtonInjected } from './DocumentsButton.tsx'
import { DocumentsModalView, useDocumentsModalLoad } from './DeferredDocumentsModal.tsx'
import type { UserDocRef, UserDocScope } from './documents-client.ts'
import { NS } from './locales.ts'

type DocumentsOverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS>
  & InjectFace<DocumentsButtonInjected> & PropsRenderFactories

/**
 * Capture each picker request's destination independently of current selection.
 * @param props - root runtime hooks, locale, and document callbacks.
 * @returns the document manager while open.
 */
export function DocumentsOverlay({
  t, attachDocument, canAttachDocument, useSessions, useDeployment, privateResourceUrl, documentScopeFor,
  renderFactorySlot,
}: DocumentsOverlayProps) {
  const deployment = useDeployment(state => state)
  const currentSessionId = useSessions(snapshot => snapshot.current)
  const [open, setOpen] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const [mode, setMode] = useState<'manage' | 'select'>('manage')
  const [targetSessionId, setTargetSessionId] = useState<SessionId | undefined>()
  const [attachmentScope, setAttachmentScope] = useState<UserDocScope | undefined>()
  const loader = useDocumentsModalLoad()
  const { load } = loader
  const handleClose = useCallback(() => { setOpen(false) }, [])

  useEffect(() => {
    const openPicker = (event: Event): void => {
      load()
      const detail = event instanceof CustomEvent && typeof event.detail === 'object' && event.detail !== null
        ? event.detail as { mode?: unknown; sessionId?: unknown }
        : undefined
      setMode(detail?.mode === 'select' ? 'select' : 'manage')
      const target = typeof detail?.sessionId === 'string' ? detail.sessionId as SessionId : currentSessionId
      setTargetSessionId(target)
      setAttachmentScope(target === undefined ? undefined : documentScopeFor?.(target))
      setHasOpened(true)
      setOpen(true)
    }
    window.addEventListener('dsh-documents-open-picker', openPicker)
    return () => { window.removeEventListener('dsh-documents-open-picker', openPicker) }
  }, [currentSessionId, documentScopeFor, load])

  if (!hasOpened) return null
  return <DocumentsModalView
    loader={loader}
    renderFactorySlot={renderFactorySlot}
    open={open}
    showComputer={deployment.showComputer}
    allowedNodeId={deployment.aggregateComputers ? undefined : deployment.context?.entry.nodeId}
    onClose={handleClose}
    t={t}
    mode={mode}
    privateResourceUrl={privateResourceUrl}
    attachmentScope={attachmentScope}
    attachmentTargetId={targetSessionId}
    {...(attachDocument === undefined || targetSessionId === undefined && mode !== 'select' ? {} : {
      canAttachDocument: () => targetSessionId !== undefined && (canAttachDocument?.(targetSessionId) ?? true),
      onAttachDocument: (document: UserDocRef) => targetSessionId !== undefined && attachDocument(document, targetSessionId),
    })}
  />
}
