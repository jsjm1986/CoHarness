/** Explicit human confirmation bound to the displayed root, node and desktop. */
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { clientSessionKey, parseClientSessionKey } from '@deepseek-ai/dsh-client-runtime/client'
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { DesktopConfirmation, DesktopStatus, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconFollowsystemOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
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
export type DesktopConfirmationProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'permission.desktop'> & InjectFace<DesktopConfirmationInjected>

/**
 * Show personal confirmation and discard responses after scope or connection changes.
 * Keep known limitations in the same Session while clearing consent on connection loss.
 * @param props - exact Session binding and runtime transport.
 * @returns a managed-runtime header utility and accessible confirmation dialog.
 */
export function DesktopConfirmationAction({ sessionId, connection, t }: DesktopConfirmationProps): React.JSX.Element | null {
  const connectionState = useSyncExternalStore(cb => connection.state.subscribe(cb), () => connection.state.getSnapshot())
  const host = useSyncExternalStore(cb => connection.hostDescription.subscribe(cb), () => connection.hostDescription.getSnapshot())
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<DesktopStatus | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const active = useRef<AbortController | undefined>(undefined)
  const ready = connectionState === 'connected' && host?.executionAuthorityRequired === true
  const environmentReason = host?.computerUseUnavailableReason
  const read = useCallback(async (priority?: 'low') => {
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setValue(previous => previous !== undefined && previous !== null && 'unavailableReason' in previous ? previous : undefined)
    setBusy(true); setError(false)
    try {
      const response = await connection.api.desktop.status({ sessionId }, request.signal, priority)
      if (request.signal.aborted) return
      if (!response.result.ok) throw new Error('desktop status refused')
      setValue(response.result.value)
    } catch {
      if (!request.signal.aborted) setError(true)
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }, [connection, sessionId])
  const readFor = useRef<{
    connection: ConnectionHandle
    sessionId: SessionId
    ready: boolean
    environmentReason: typeof environmentReason
  } | undefined>(undefined)
  useLayoutEffect(() => {
    active.current?.abort()
    const sameOwner = readFor.current?.connection === connection && readFor.current.sessionId === sessionId
    if (!sameOwner) setValue(undefined)
    if (!ready) {
      readFor.current = sameOwner ? { connection, sessionId, ready: false, environmentReason } : undefined
      setValue(previous => sameOwner && previous !== undefined && previous !== null && 'unavailableReason' in previous ? previous : undefined)
      setBusy(false); setError(false)
      return
    }
    if (environmentReason !== undefined && !open) {
      readFor.current = { connection, sessionId, ready: true, environmentReason }
      setValue({ unavailableReason: environmentReason }); setBusy(false); setError(false)
      return
    }
    // The trigger's status dot needs the value before the first open; a
    // changed session binding counts as unread, and every open refreshes.
    if (open || !sameOwner || readFor.current?.ready !== true || readFor.current.environmentReason !== environmentReason) {
      readFor.current = { connection, sessionId, ready: true, environmentReason }
      void read(open ? undefined : 'low')
    }
    return () => { active.current?.abort() }
  }, [open, ready, read, connection, sessionId, environmentReason])
  const save = async (target: DesktopConfirmation, confirmed: boolean) => {
    active.current?.abort()
    const request = new AbortController()
    active.current = request
    setBusy(true); setError(false)
    try {
      const address = parseClientSessionKey(sessionId)
      const rootSessionId = address === undefined ? target.rootSessionId : clientSessionKey(address.runtime, target.rootSessionId)
      const response = await connection.api.desktop.confirm({ sessionId, rootSessionId,
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
  const ownedValue = readFor.current?.connection === connection && readFor.current.sessionId === sessionId ? value : undefined
  const currentValue = ownedValue === undefined && environmentReason !== undefined ? { unavailableReason: environmentReason } : ownedValue
  const unavailable = currentValue !== undefined && currentValue !== null && 'unavailableReason' in currentValue
  const confirmation = currentValue === undefined || currentValue === null || unavailable ? undefined : currentValue
  if (!open && (host?.executionAuthorityRequired === false || host?.executionAuthorityRequired !== true && !unavailable)) return null
  const dot = currentValue === undefined ? undefined : confirmation === undefined ? 'off' : confirmation.confirmed ? 'ok' : 'warn'
  const statusKey = dot === 'ok' ? 'statusConfirmed' : dot === 'warn' ? 'statusPending' : dot === 'off' ? 'statusUnavailable' : undefined
  return <>
    <button
      type="button"
      className={css.trigger}
      aria-label={t('open')}
      aria-description={statusKey === undefined ? undefined : t(statusKey)}
      title={statusKey === undefined ? t('open') : `${t('open')} · ${t(statusKey)}`}
      onClick={() => { setOpen(true) }}
    >
      <IconFollowsystemOutline16 />
      {dot === undefined ? null : <i className={css.dot} data-state={dot} aria-hidden />}
    </button>
    <Modal open={open} title={t('title')} closeLabel={t('close')} onClose={() => { setOpen(false) }}
      footer={<>
        <Button disabled={!ready || busy} onClick={() => { void read() }}>{t('refresh')}</Button>
        {confirmation !== undefined && <Button disabled={!ready || busy || (!confirmation.confirmed && !confirmation.eligible)}
          onClick={() => { void save(confirmation, !confirmation.confirmed) }}>{busy ? t('saving') : t(confirmation.confirmed ? 'withdraw' : 'confirm')}</Button>}
      </>}>
      <div className={css.body}>
        <div className={css.iconWrap} aria-hidden>🖥️</div>
        {!unavailable && <p className={css.desc}>{t('description')}</p>}
        {unavailable ? <p role="status" className={css.desc}>{t(currentValue.unavailableReason === 'headless' ? 'headless' : 'disabled')}</p>
          : !ready ? <p role="status" className={css.desc}>{t('disconnected')}</p>
            : error ? <p role="alert" className={css.desc}>{t('failed')}</p>
              : currentValue === undefined ? <p role="status" className={css.desc}>{t('loading')}</p>
                : currentValue === null ? <p className={css.desc}>{t('unavailable')}</p> : <>
                  <dl className={css.meta}>
                    <div className={css.metaRow}>
                      <dt className={css.metaLabel}>{t('desktop')}</dt>
                      <dd className={css.metaValue}>{currentValue.desktop}</dd>
                    </div>
                    <div className={css.metaRow}>
                      <dt className={css.metaLabel}>{t('node')}</dt>
                      <dd className={css.metaValue}>{currentValue.nodeId}</dd>
                    </div>
                    <div className={css.metaRow}>
                      <dt className={css.metaLabel}>{t('root')}</dt>
                      <dd className={css.metaValue}>{currentValue.rootSessionId}</dd>
                    </div>
                    <div className={css.metaRow}>
                      <dt className={css.metaLabel}>{t('account')}</dt>
                      <dd className={css.metaValue}>{currentValue.userId}</dd>
                    </div>
                  </dl>
                  {!currentValue.eligible
                    ? <div role="status" className={`${css.scopeNote} ${css.scopeNoteInfo}`}><span className={css.scopeNoteIcon} aria-hidden />{t('ineligible')}</div>
                    : currentValue.confirmed
                      ? <div role="status" className={`${css.scopeNote} ${css.scopeNoteOk}`}><span className={css.scopeNoteIcon} aria-hidden />{t('granted')}</div>
                      : <div role="status" className={`${css.scopeNote} ${css.scopeNoteInfo}`}><span className={css.scopeNoteIcon} aria-hidden />{t('unconfirmed')}</div>}
                </>}
      </div>
    </Modal>
  </>
}
