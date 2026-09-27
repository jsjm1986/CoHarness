/** Explicit human confirmation bound to the displayed root, node and desktop. */
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { DesktopConfirmation } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopKey } from './desktop-locales.ts'
import css from './DesktopConfirmationAction.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'permission.desktop': DesktopKey
  }
}

/** Session-owned transport supplied by the permission plugin. */
export interface DesktopConfirmationInjected { connection: ConnectionHandle }
/** Session kit, localized copy and its exact runtime transport. */
export type DesktopConfirmationProps = PropsRuntime<'conversation.input.left'>
  & PropsLocale<'permission.desktop'> & InjectFace<DesktopConfirmationInjected>

/**
 * Show personal confirmation and discard responses after scope or connection changes.
 * @param props - exact Session binding and runtime transport.
 * @returns a managed-runtime composer action and accessible confirmation dialog.
 */
export function DesktopConfirmationAction({ sessionId, connection, t }: DesktopConfirmationProps): React.JSX.Element | null {
  const connectionState = useSyncExternalStore(cb => connection.state.subscribe(cb), () => connection.state.getSnapshot())
  const host = useSyncExternalStore(cb => connection.hostDescription.subscribe(cb), () => connection.hostDescription.getSnapshot())
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<DesktopConfirmation | null | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const active = useRef<AbortController | undefined>(undefined)
  const ready = connectionState === 'connected' && host?.executionAuthorityRequired === true
  const read = useCallback(async () => {
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setValue(undefined); setBusy(true); setError(false)
    try {
      const response = await connection.api.desktop.status({ sessionId }, request.signal)
      if (request.signal.aborted) return
      if (!response.result.ok) throw new Error('desktop status refused')
      setValue(response.result.value)
    } catch {
      if (!request.signal.aborted) setError(true)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }, [connection, sessionId])
  useLayoutEffect(() => {
    active.current?.abort()
    setValue(undefined); setBusy(false); setError(false)
    if (open && ready) void read()
    return () => { active.current?.abort() }
  }, [open, ready, read, host])
  const save = async (target: DesktopConfirmation, confirmed: boolean) => {
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setBusy(true); setError(false)
    try {
      const response = await connection.api.desktop.confirm({ sessionId, rootSessionId: target.rootSessionId,
        nodeId: target.nodeId, desktop: target.desktop, confirmed }, request.signal)
      if (request.signal.aborted) return
      if (!response.result.ok) throw new Error('desktop confirmation refused')
      setValue(response.result.value)
    } catch {
      if (!request.signal.aborted) { setError(true); setValue(undefined) }
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  if (host?.executionAuthorityRequired !== true && !open) return null
  return <>
    <Button onClick={() => { setOpen(true) }}>{t('open')}</Button>
    <Modal open={open} title={t('title')} closeLabel={t('close')} onClose={() => { setOpen(false) }}
      footer={<>
        <Button disabled={!ready || busy} onClick={() => { void read() }}>{t('refresh')}</Button>
        {value !== undefined && value !== null && <Button disabled={!ready || busy || (!value.confirmed && !value.eligible)}
          onClick={() => { void save(value, !value.confirmed) }}>{busy ? t('saving') : t(value.confirmed ? 'withdraw' : 'confirm')}</Button>}
      </>}>
      <p>{t('description')}</p>
      {!ready ? <p role="status">{t('disconnected')}</p> : error ? <p role="alert">{t('failed')}</p>
        : value === undefined ? <p role="status">{t('loading')}</p>
          : value === null ? <p>{t('unavailable')}</p> : <>
            <dl className={css.target}>
              <dt>{t('root')}</dt><dd>{value.rootSessionId}</dd>
              <dt>{t('node')}</dt><dd>{value.nodeId}</dd>
              <dt>{t('desktop')}</dt><dd>{value.desktop}</dd>
              <dt>{t('account')}</dt><dd>{value.userId}</dd>
            </dl>
            <p role="status">{t(!value.eligible ? 'ineligible' : value.confirmed ? 'granted' : 'unconfirmed')}</p>
          </>}
    </Modal>
  </>
}
