/** Remote-desktop tab body: grant status, explicit consent, attach, and the RFB screen. */
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DockMode } from '@deepseek-ai/dsh-client-ui-dockkit'
import {
  Button, IconChevronDownOutline14, IconFullscreenOutline16, IconMinimizeOutline16, Menu, SegmentedControl,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  RemoteDesktopStatusView, RemoteDesktopTargetView,
} from '@deepseek-ai/dsh-api-remote-desktop-controller/types'
import type { RemoteDesktopAttachment } from '@deepseek-ai/dsh-api-remote-desktop-controller/client'
import type { RemoteDesktopInjected, RemoteDesktopQuality, RemoteDesktopScreen, RemoteDesktopZoom } from './face.ts'
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
  const { sidebar, tab } = useTabInfo()
  const params = tab.navigation.params
  const target: RemoteDesktopTargetView | undefined = params !== undefined && 'nodeId' in params
    ? { nodeId: params.nodeId, ...(params.desktop === undefined ? {} : { desktop: params.desktop }) }
    : undefined
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [retry, setRetry] = useState(0)
  const gate = useRef<AbortController | undefined>(undefined)
  // The operator's zoom/quality picks outlive each RfbSurface mount: a phase
  // round-trip (attach → live → reconnect) unmounts the surface, so the picks
  // ride on the body and each surface mounts with them pre-applied.
  const picks = useRef<{ zoom: RemoteDesktopZoom; quality: RemoteDesktopQuality }>({ zoom: 'fit', quality: 'balanced' })

  // A live desktop wants the whole frame: ask once per mount, at the first
  // moment the tab is both live and on screen. An operator who backs out of
  // fullscreen is not re-pulled until the body remounts.
  const fullscreenAsked = useRef(false)

  // A retargeted tab (the guide opens targets with replaceTab) must not carry
  // the previous target's picks, fullscreen memory, or rendered status: drop
  // them synchronously so no render ever mixes two targets.
  const targetKey = target === undefined ? undefined : `${target.nodeId}/${target.desktop ?? ''}`
  const [shownKey, setShownKey] = useState(targetKey)
  if (shownKey !== targetKey) {
    setShownKey(targetKey)
    setPhase({ kind: 'loading' })
    picks.current = { zoom: 'fit', quality: 'balanced' }
    fullscreenAsked.current = false
  }
  const sameTarget = (status: RemoteDesktopStatusView): boolean =>
    target !== undefined && status.target.nodeId === target.nodeId && status.target.desktop === target.desktop
  useEffect(() => {
    if (phase.kind !== 'live' || !tab.visible || fullscreenAsked.current || sidebar.fullscreen) return
    fullscreenAsked.current = true
    tab.actions.setPanelMode('fullscreen')
  }, [phase.kind, tab.visible, sidebar.fullscreen, tab.actions])

  const deny = (error: unknown): void => {
    setPhase({ kind: 'denied', code: issueOf(error), message: error instanceof Error ? error.message : String(error) })
  }

  const settleDenied = (controller: AbortController, error: unknown, current: RemoteDesktopStatusView): void => {
    if (controller.signal.aborted) return
    const code = issueOf(error)
    if (code === 'consentRequired') setPhase({ kind: 'consent', status: current })
    else setPhase({ kind: 'denied', code, message: error instanceof Error ? error.message : String(error) })
  }

  const attachNow = async (current: RemoteDesktopStatusView): Promise<void> => {
    const controller = gate.current
    if (target === undefined || controller === undefined || !sameTarget(current)) return
    setPhase({ kind: 'attaching', status: current })
    try {
      const attachment = await attach(target, current.level, controller.signal)
      if (controller.signal.aborted) return
      setPhase({ kind: 'live', status: current, attachment })
    } catch (error) {
      settleDenied(controller, error, current)
    }
  }

  const consentNow = async (current: RemoteDesktopStatusView): Promise<void> => {
    const controller = gate.current
    if (target === undefined || controller === undefined || !sameTarget(current)) return
    setPhase({ kind: 'attaching', status: current })
    try {
      await confirm(target, current.level, controller.signal)
      if (controller.signal.aborted) return
      const attachment = await attach(target, current.level, controller.signal)
      controller.signal.throwIfAborted()
      setPhase({ kind: 'live', status: current, attachment })
    } catch (error) {
      settleDenied(controller, error, current)
    }
  }

  useEffect(() => {
    if (target === undefined) return
    const controller = new AbortController()
    gate.current = controller
    void (async () => {
      setPhase({ kind: 'loading' })
      try {
        const next = await status(target, controller.signal)
        if (controller.signal.aborted) return
        if (!next.available) { setPhase({ kind: 'denied', code: 'unavailable', message: '' }); return }
        if (next.consented) await attachNow(next)
        else setPhase({ kind: 'consent', status: next })
      } catch (error) {
        if (controller.signal.aborted) return
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
        <Button variant="outline" size="sm" onClick={() => { setRetry(count => count + 1) }}>{t('retry')}</Button>
      </div>
    )
    case 'consent': return (
      <div className={css.consent}>
        <h2 className={css.heading}>{t('consentTitle')}</h2>
        <p>{(phase.status.level === 'control' ? t('consentControl') : t('consentView')).replace('{node}', phase.status.target.nodeId)}</p>
        {phase.status.recording && <p className={css.recordingLine}>{t('consentRecording')}</p>}
        <p className={css.detail}>
          {t('desktop')}: {phase.status.target.desktop ?? '—'} · {phase.status.level === 'control' ? t('control') : t('viewOnly')}
        </p>
        <Button variant="primary" size="md" className={css.consentAction} onClick={() => void consentNow(phase.status)}>{t('consentAction')}</Button>
      </div>
    )
    case 'attaching': return <p className={css.notice}>{t('attaching')}</p>
    case 'live': return (
      <RfbSurface
        openScreen={openScreen} url={phase.attachment.url} spec={phase.attachment.spec}
        t={t} fullscreen={sidebar.fullscreen} onPanelMode={(mode) => { tab.actions.setPanelMode(mode) }}
        onReconnect={() => { setRetry(count => count + 1) }}
        picks={picks}
      />
    )
  }
}

/** The live surface: chrome controls plus the RFB canvas. Mounts the screen
 * once per attachment URL, answers the server's credentials challenge inside
 * the tab, and offers disconnect/reconnect around the stream's own lifecycle. */
function RfbSurface({ openScreen, url, spec, t, fullscreen, onPanelMode, onReconnect, picks }: Pick<RemoteDesktopInjected, 'openScreen'> & Pick<BodyProps, 't'> & {
  url: string
  spec: RemoteDesktopAttachment['spec']
  fullscreen: boolean
  onPanelMode: (mode: DockMode) => void
  onReconnect: () => void
  picks: { current: { zoom: RemoteDesktopZoom; quality: RemoteDesktopQuality } }
}): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const screen = useRef<RemoteDesktopScreen | undefined>(undefined)
  const [challenge, setChallenge] = useState<readonly string[] | undefined>(undefined)
  const [closed, setClosed] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [zoom, setZoom] = useState<RemoteDesktopZoom>(picks.current.zoom)
  const [quality, setQuality] = useState<RemoteDesktopQuality>(picks.current.quality)
  const [qualityOpen, setQualityOpen] = useState(false)
  // Refs carry the operator's picks across attachments without restarting the
  // mount effect: a reconnect re-applies them, a live change only re-tunes.
  const zoomId = useId()
  useEffect(() => {
    const host = container.current
    if (host === null) return
    setClosed(false)
    setChallenge(undefined)
    const next = openScreen(host, url, {
      viewOnly: spec.level === 'view',
      onCredentialsRequired: (types) => { setChallenge(types) },
      onDisconnected: () => { setClosed(true) },
    })
    setUsername('')
    setPassword('')
    screen.current = next
    next.setZoom(picks.current.zoom)
    next.setQuality(picks.current.quality)
    return () => { screen.current = undefined; next.disconnect() }
  }, [openScreen, url, spec.level])
  const disconnect = (): void => {
    setChallenge(undefined)
    screen.current?.disconnect()
    setClosed(true)
  }
  const changeZoom = (next: RemoteDesktopZoom): void => {
    picks.current = { ...picks.current, zoom: next }
    setZoom(next)
    screen.current?.setZoom(next)
  }
  const changeQuality = (next: RemoteDesktopQuality): void => {
    picks.current = { ...picks.current, quality: next }
    setQuality(next)
    screen.current?.setQuality(next)
  }
  const sendCredentials = (event: SyntheticEvent): void => {
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
  const qualityItems: readonly MenuEntry[] = (['sharp', 'balanced', 'smooth'] as const).map(level => ({
    id: level,
    label: t(`quality_${level}`),
  }))
  return <div className={css.screen}>
    <div className={css.chrome}>
      <span className={css.badge} data-level={spec.level}>{spec.level === 'control' ? t('control') : t('viewOnly')}</span>
      {spec.recording && <span className={css.recording}>{t('recording')}</span>}
      <span className={css.chromeDivider} />
      <SegmentedControl
        id={zoomId}
        label={t('zoom')}
        value={zoom}
        disabled={closed}
        options={[
          { value: 'fit', label: t('zoomFit') },
          { value: 'actual', label: t('zoomActual'), title: t('zoomActualHint') },
        ]}
        onChange={changeZoom}
      />
      <Menu
        open={qualityOpen}
        portal
        selectedId={quality}
        anchor={(
          <Button
            variant="ghost" size="toolbar" disabled={closed}
            title={t('quality')}
            onClick={() => { setQualityOpen(open => !open) }}
          >
            {t('quality')}: {t(`quality_${quality}`)}
            <IconChevronDownOutline14 />
          </Button>
        )}
        items={qualityItems}
        onSelect={(id) => { changeQuality(id as RemoteDesktopQuality); setQualityOpen(false) }}
        onClose={() => { setQualityOpen(false) }}
      />
      <span className={css.chromeSpacer} />
      {spec.level === 'control' && !closed && (
        <Button variant="ghost" size="toolbar" title={t('ctrlAltDelHint')}
          onClick={() => { screen.current?.sendCtrlAltDel() }}>
          {t('ctrlAltDel')}
        </Button>
      )}
      <Button
        variant="ghost" size="toolbar"
        icon={fullscreen ? <IconMinimizeOutline16 /> : <IconFullscreenOutline16 />}
        title={fullscreen ? t('exitFullscreen') : t('fullscreen')}
        aria-label={fullscreen ? t('exitFullscreen') : t('fullscreen')}
        onClick={() => { onPanelMode(fullscreen ? 'push' : 'fullscreen') }}
      />
      {!closed && <Button variant="outline" size="sm" onClick={disconnect}>{t('disconnect')}</Button>}
    </div>
    <div
      ref={container}
      id={`${zoomId}-${zoom}-panel`}
      role="tabpanel"
      aria-labelledby={`${zoomId}-${zoom}`}
      className={css.canvas}
    >
      {closed && (
        <div className={css.auth}>
          <p>{t('closed')}</p>
          <Button variant="primary" size="sm" className={css.consentAction} onClick={onReconnect}>{t('reconnect')}</Button>
        </div>
      )}
      {challenge !== undefined && !closed && (
        <form className={css.auth} onSubmit={sendCredentials}>
          <p className={css.heading}>{t('credentialsTitle')}</p>
          {challenge.includes('username') && (
            <input className={css.field} required autoFocus value={username} placeholder={t('username')}
              aria-label={t('username')} onChange={(event) => { setUsername(event.currentTarget.value) }} />
          )}
          {challenge.includes('password') && (
            <input className={css.field} required type="password" autoFocus={!challenge.includes('username')}
              value={password} placeholder={t('password')} aria-label={t('password')}
              onChange={(event) => { setPassword(event.currentTarget.value) }} />
          )}
          <Button variant="primary" size="sm" className={css.consentAction} type="submit">{t('credentialsAction')}</Button>
        </form>
      )}
    </div>
  </div>
}
