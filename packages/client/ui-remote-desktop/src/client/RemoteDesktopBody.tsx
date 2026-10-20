/** Remote-desktop tab body: grant status, explicit consent, attach, and the RFB screen. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RemoteDesktopStatusView, RemoteDesktopTargetView,
} from '@deepseek-ai/dsh-api-remote-desktop-controller/types'
import type { RemoteDesktopAttachment } from '@deepseek-ai/dsh-api-remote-desktop-controller/client'
import type { RemoteDesktopInjected, RemoteDesktopScreen } from './face.ts'
import type {} from './locales.ts'
import css from './RemoteDesktopBody.module.css'

type BodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'remoteDesktop'> & InjectFace<RemoteDesktopInjected>

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'denied'; readonly code: string; readonly message: string }
  | { readonly kind: 'consent'; readonly status: RemoteDesktopStatusView }
  | { readonly kind: 'attaching'; readonly status: RemoteDesktopStatusView }
  | { readonly kind: 'live'; readonly status: RemoteDesktopStatusView; readonly attachment: RemoteDesktopAttachment }

/** Capability error code → the translated copy key the operator can act on. */
function issueOf(error: unknown): string {
  const failure = remoteErrorOf(error)
  if (failure?.code === 'remote-desktop/forbidden') return 'forbidden'
  if (failure?.code === 'remote-desktop/unavailable') return 'unavailable'
  if (failure?.code === 'remote-desktop/failure') {
    if (failure.details.code === 'REMOTE_DESKTOP_FORBIDDEN') return 'forbidden'
    if (failure.details.code === 'REMOTE_DESKTOP_TARGET_UNAVAILABLE') return 'unavailable'
    if (failure.details.code === 'REMOTE_DESKTOP_STALE_TARGET') return 'stale'
    if (failure.details.code === 'REMOTE_DESKTOP_CONSENT_REQUIRED') return 'consentRequired'
  }
  return 'failed'
}

/**
 * Render the consent card or the live RFB screen for one remote-desktop tab.
 * Consent and level enforcement happen in the capability; this component only
 * performs the operator gesture and opens the returned stream.
 * @param props - sidebar occurrence, injected Remote calls, and localized copy.
 * @returns the status, consent, or screen surface for the tab's target.
 */
export function RemoteDesktopBody({ status, confirm, attach, openScreen, useTabInfo, t }: BodyProps): ReactNode {
  const { tab } = useTabInfo()
  const params = tab.navigation.params
  const target: RemoteDesktopTargetView | undefined = params !== undefined && 'nodeId' in params
    ? { nodeId: params.nodeId, ...(params.desktop === undefined ? {} : { desktop: params.desktop }) }
    : undefined
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [retry, setRetry] = useState(0)
  const run = useRef(0)
  const gate = useRef<AbortController | undefined>(undefined)

  const deny = (error: unknown): void => {
    setPhase({ kind: 'denied', code: issueOf(error), message: error instanceof Error ? error.message : String(error) })
  }

  const attachNow = async (current: RemoteDesktopStatusView): Promise<void> => {
    const attempt = run.current
    const controller = gate.current
    if (target === undefined || controller === undefined) return
    setPhase({ kind: 'attaching', status: current })
    try {
      const attachment = await attach(target, current.level, controller.signal)
      if (controller.signal.aborted || run.current !== attempt) return
      setPhase({ kind: 'live', status: current, attachment })
    } catch (error) {
      if (controller.signal.aborted || run.current !== attempt) return
      const code = issueOf(error)
      if (code === 'consentRequired') setPhase({ kind: 'consent', status: current })
      else setPhase({ kind: 'denied', code, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const consentNow = async (current: RemoteDesktopStatusView): Promise<void> => {
    const attempt = run.current
    const controller = gate.current
    if (target === undefined || controller === undefined) return
    setPhase({ kind: 'attaching', status: current })
    try {
      await confirm(target, current.level, controller.signal)
      if (controller.signal.aborted || run.current !== attempt) return
      const attachment = await attach(target, current.level, controller.signal)
      if (controller.signal.aborted || run.current !== attempt) return
      setPhase({ kind: 'live', status: current, attachment })
    } catch (error) {
      if (controller.signal.aborted || run.current !== attempt) return
      const code = issueOf(error)
      if (code === 'consentRequired') setPhase({ kind: 'consent', status: current })
      else setPhase({ kind: 'denied', code, message: error instanceof Error ? error.message : String(error) })
    }
  }

  useEffect(() => {
    if (target === undefined) return
    const attempt = ++run.current
    const controller = new AbortController()
    gate.current = controller
    void (async () => {
      setPhase({ kind: 'loading' })
      try {
        const next = await status(target, controller.signal)
        if (controller.signal.aborted || run.current !== attempt) return
        if (next.consented) await attachNow(next)
        else setPhase({ kind: 'consent', status: next })
      } catch (error) {
        if (controller.signal.aborted || run.current !== attempt) return
        deny(error)
      }
    })()
    return () => { controller.abort(new Error('remote-desktop tab unmounted')) }
  }, [target?.nodeId, target?.desktop, retry])

  if (target === undefined) return <p className={css.notice}>{t('stale')}</p>
  switch (phase.kind) {
    case 'loading': return <p className={css.notice}>{t('connecting')}</p>
    case 'denied': return (
      <div className={css.notice}>
        <p>{phase.code === 'failed' ? t('failed').replace('{message}', phase.message) : t(phase.code as 'forbidden' | 'unavailable' | 'stale' | 'consentRequired')}</p>
        <button type="button" className={css.action} onClick={() => setRetry(count => count + 1)}>{t('retry')}</button>
      </div>
    )
    case 'consent': return (
      <div className={css.consent}>
        <h2 className={css.heading}>{t('consentTitle')}</h2>
        <p>{(phase.status.level === 'control' ? t('consentControl') : t('consentView')).replace('{node}', phase.status.target.nodeId)}</p>
        {phase.status.recording && <p className={css.recording}>{t('consentRecording')}</p>}
        <p className={css.detail}>
          {t('desktop')}: {phase.status.target.desktop ?? '—'} · {phase.status.level === 'control' ? t('control') : t('viewOnly')}
        </p>
        <button type="button" className={css.action} onClick={() => void consentNow(phase.status)}>{t('consentAction')}</button>
      </div>
    )
    case 'attaching': return <p className={css.notice}>{t('attaching')}</p>
    case 'live': return (
      <div className={css.screen}>
        <div className={css.chrome}>
          <span className={css.badge}>{phase.attachment.spec.level === 'control' ? t('control') : t('viewOnly')}</span>
          {phase.attachment.spec.recording && <span className={css.recording}>{t('consentRecording')}</span>}
        </div>
        <RfbSurface openScreen={openScreen} url={phase.attachment.url} viewOnly={phase.attachment.spec.level === 'view'} t={t} />
      </div>
    )
  }
}

/** The RFB canvas container; mounts the screen once per attachment URL and
 * answers the server's credentials challenge inside the tab. */
function RfbSurface({ openScreen, url, viewOnly, t }: Pick<RemoteDesktopInjected, 'openScreen'> & Pick<BodyProps, 't'> & { url: string; viewOnly: boolean }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const screen = useRef<RemoteDesktopScreen | undefined>(undefined)
  const [challenge, setChallenge] = useState<readonly string[] | undefined>(undefined)
  const [closed, setClosed] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  useEffect(() => {
    const host = container.current
    if (host === null) return
    setClosed(false)
    setChallenge(undefined)
    const next = openScreen(host, url, {
      viewOnly,
      onCredentialsRequired: types => setChallenge(types),
      onDisconnected: () => setClosed(true),
    })
    screen.current = next
    return () => { screen.current = undefined; next.disconnect() }
  }, [openScreen, url, viewOnly])
  const sendCredentials = (event: FormEvent): void => {
    event.preventDefault()
    const current = screen.current
    if (current === undefined || challenge === undefined) return
    current.sendCredentials({
      ...(challenge.includes('username') ? { username } : {}),
      ...(challenge.includes('password') ? { password } : {}),
    })
    setPassword('')
    setChallenge(undefined)
  }
  return <div ref={container} className={css.canvas}>
    {closed && <p className={css.auth}>{t('closed')}</p>}
    {challenge !== undefined && !closed && (
      <form className={css.auth} onSubmit={sendCredentials}>
        <p className={css.heading}>{t('credentialsTitle')}</p>
        {challenge.includes('username') && (
          <input className={css.field} required autoFocus value={username} placeholder={t('username')}
            aria-label={t('username')} onChange={event => setUsername(event.currentTarget.value)} />
        )}
        {challenge.includes('password') && (
          <input className={css.field} required type="password" autoFocus={!challenge.includes('username')}
            value={password} placeholder={t('password')} aria-label={t('password')}
            onChange={event => setPassword(event.currentTarget.value)} />
        )}
        <button type="submit" className={css.action}>{t('credentialsAction')}</button>
      </form>
    )}
  </div>
}
