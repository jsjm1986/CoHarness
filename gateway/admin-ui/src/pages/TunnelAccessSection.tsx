/** Public-access tunnel: cloudflared installation, one-click quick links, and the own-domain named tunnel. */
import { usePendingEdits } from '../pending-edits.tsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, ExternalLink, Globe, Link2, Square, Trash2 } from 'lucide-react'
import {
  getTunnelAccess, installTunnelBinary, tunnelAccessAction, type TunnelAccessView,
} from '../api.ts'
import {
  Button, ConfirmDialog, ErrorBanner, Field, LoadingState, Section, StatusBadge,
} from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as copyZh, en as copyEn, type TunnelAccessCopyKey } from './tunnel-access.copy.ts'

const messageOf = (error: unknown): string => error instanceof Error
  ? error.message
  : translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })('operationFailed')

const STATE_LABEL: Record<TunnelAccessView['state'], { labelKey: TunnelAccessCopyKey; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  stopped: { labelKey: 'stateStopped', tone: 'neutral' },
  starting: { labelKey: 'stateStarting', tone: 'warning' },
  running: { labelKey: 'stateRunning', tone: 'success' },
  error: { labelKey: 'stateError', tone: 'danger' },
}

const MODE_LABEL: Record<TunnelAccessView['mode'], TunnelAccessCopyKey> = {
  off: 'modeOff',
  quick: 'modeQuick',
  named: 'modeNamed',
}

type Action = 'install' | 'start' | 'stop' | 'clear'

export function TunnelAccessSection() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  const [view, setView] = useState<TunnelAccessView | null>(null)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [notice, setNotice] = useState('')
  const [action, setAction] = useState<Action | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [hostname, setHostname] = useState('')
  const [domain, setDomain] = useState('')
  const [apiToken, setApiToken] = useState('')
  usePendingEdits(action !== null || apiToken !== '' || view !== null && (hostname !== (view.hostname ?? '') || domain !== (view.domain ?? '')))
  const ownership = useRef({ mounted: false, action: 0, query: 0, feedback: 0, pending: null as Action | null })
  const draftInitialized = useRef(false)

  const publish = useCallback((next: TunnelAccessView) => {
    setView(next)
    if (!draftInitialized.current) {
      draftInitialized.current = true
      setHostname(next.hostname ?? '')
      setDomain(next.domain ?? '')
    }
  }, [])

  const refresh = useCallback(async () => {
    const owner = ownership.current
    const query = ++owner.query
    const actionId = owner.action
    const current = () => owner.mounted && owner.query === query && owner.action === actionId
    try {
      const next = await getTunnelAccess()
      if (!current()) return
      publish(next)
      setReadError('')
    } catch (cause) {
      if (current()) setReadError(messageOf(cause))
    }
  }, [publish])

  useEffect(() => {
    const owner = ownership.current
    owner.mounted = true
    let polling = false
    const poll = () => {
      if (polling) return
      polling = true
      void refresh().finally(() => { polling = false })
    }
    poll()
    const timer = setInterval(poll, 10_000)
    return () => {
      clearInterval(timer)
      owner.mounted = false
      owner.action++; owner.query++; owner.feedback++
    }
  }, [refresh])

  const run = async (kind: Action, work: () => Promise<TunnelAccessView>, ok: string, saved?: () => void) => {
    const owner = ownership.current
    if (owner.pending !== null && !(owner.pending === 'start' && (kind === 'stop' || kind === 'clear'))) return
    const actionId = ++owner.action
    const feedback = ++owner.feedback
    owner.query++
    owner.pending = kind
    const current = () => owner.mounted && owner.action === actionId
    setAction(kind)
    setError('')
    setNotice('')
    try {
      const next = await work()
      if (!current()) return
      owner.query++
      publish(next)
      setReadError('')
      saved?.()
      if (owner.feedback === feedback) setNotice(ok)
    } catch (cause) {
      if (current()) {
        owner.query++
        if (owner.feedback === feedback) setError(messageOf(cause))
        void refresh()
      }
    } finally {
      if (current()) {
        owner.pending = null
        setAction(null)
      }
    }
  }

  const copyLink = async (url: string) => {
    const owner = ownership.current
    const feedback = ++owner.feedback
    const current = () => owner.mounted && owner.feedback === feedback
    setError(''); setNotice('')
    try {
      await navigator.clipboard.writeText(url)
      if (current()) setNotice(t('noticeCopied'))
    } catch {
      if (current()) setError(t('copyFailed'))
    }
  }

  const busy = action !== null
  const starting = action === 'start' || view?.state === 'starting'
  const state = view === null ? null : STATE_LABEL[starting ? 'starting' : view.state]
  const editable = view !== null && !starting && view.state !== 'running'
  const canStop = view !== null && (starting || view.state === 'running' || view.state === 'error' || view.desired === 'running')
  const canClear = view !== null && (view.mode === 'named' || view.apiTokenConfigured)

  return (
    <Section
      title={t('sectionTitle')}
      meta={view === null ? undefined : (
        <>
          <StatusBadge tone={state?.tone ?? 'neutral'}>{t(state?.labelKey ?? 'stateStopped')}</StatusBadge>
          {' '}<StatusBadge tone="neutral">{t(MODE_LABEL[view.mode])}</StatusBadge>
        </>
      )}
    >
      <ErrorBanner message={error} />
      <ErrorBanner message={readError} />
      {readError === '' ? null : <Button onClick={() => void refresh()}>{t('retry')}</Button>}
      {view === null ? readError === '' ? <LoadingState label={t('loadingTunnel')} /> : null : (
        <div className="tunnelAccess">
          {notice === '' ? null : <p role="status">{notice}</p>}

          {!view.supported ? <p>{t('unsupportedPlatform')}</p> : null}

          {view.binary === null ? (
            <div className="tunnelBinary">
              <p>{t('binaryMissing')}</p>
              <Button
                variant="primary"
                icon={Download}
                loading={action === 'install'}
                disabled={busy || !view.supported}
                onClick={() => void run('install', () => installTunnelBinary(), t('noticeInstalled'))}
              >
                {action === 'install' ? t('installingBinary') : t('installBinary')}
              </Button>
            </div>
          ) : (
            <p className="sectionMeta">
              {t('binaryPresent', { version: view.binary.version ?? t('binaryVersionUnknown'), path: view.binary.path })}
            </p>
          )}

          {view.state === 'running' && view.publicUrl !== null ? (
            <div className="tunnelRunning">
              <div className="field">
                <span className="fieldLabel">{t('publicUrlLabel')}</span>
                <div className="tunnelUrl">
                  <a href={view.publicUrl} target="_blank" rel="noreferrer">{view.publicUrl}<ExternalLink aria-hidden="true" /></a>
                  <Button icon={Copy} onClick={() => void copyLink(view.publicUrl ?? '')}>{t('copyLink')}</Button>
                </div>
              </div>
              <p className="fieldHint">{t('publicWarning')}</p>
            </div>
          ) : null}

          {view.lastError === null ? null : <p className="errorText">{t('lastErrorLabel')}：{view.lastError}</p>}

          {view.binary !== null && editable ? (
            <div className="tunnelChoices">
              <div className="tunnelChoice">
                <h3><Link2 aria-hidden="true" /> {t('quickTitle')}</h3>
                <p>{t('quickDescription')}</p>
                <Button
                  variant="primary"
                  disabled={busy || !view.supported}
                  onClick={() => void run('start', () => tunnelAccessAction({ action: 'start-quick' }), t('noticeStarted'))}
                >
                  {t('startQuick')}
                </Button>
              </div>
              <div className="tunnelChoice">
                <h3><Globe aria-hidden="true" /> {t('namedTitle')}</h3>
                <p>{t('namedDescription')}</p>
                <Field label={t('fieldHostname')}>
                  <input className="input" disabled={busy} value={hostname} onChange={event => { setHostname(event.target.value) }} placeholder={t('placeholderHostname')} />
                </Field>
                <Field label={t('fieldDomain')}>
                  <input className="input" disabled={busy} value={domain} onChange={event => { setDomain(event.target.value) }} placeholder={t('placeholderDomain')} />
                </Field>
                <Field
                  label={t('fieldApiToken')}
                  hint={view.apiTokenConfigured ? t('apiTokenStored') : t('hintApiToken')}
                >
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    disabled={busy}
                    value={apiToken}
                    onChange={event => { setApiToken(event.target.value) }}
                    placeholder={t('placeholderApiToken')}
                  />
                </Field>
                <Button
                  disabled={busy || !view.supported || hostname.trim() === ''}
                  onClick={() => void run('start', () => tunnelAccessAction({
                    action: 'start-named',
                    hostname: hostname.trim(),
                    ...(domain.trim() === '' ? {} : { domain: domain.trim() }),
                    ...(apiToken === '' ? {} : { apiToken }),
                  }), t('noticeStarted'), () => { setApiToken(current => current === apiToken ? '' : current) })}
                >
                  {t('startNamed')}
                </Button>
              </div>
            </div>
          ) : null}

          {canStop || canClear ? (
            <div className="tunnelActions">
              {canStop ? (
                <Button icon={Square} loading={action === 'stop'} disabled={busy && action !== 'start'} onClick={() => void run('stop', () => tunnelAccessAction({ action: 'stop' }), t('noticeStopped'))}>
                  {t('stop')}
                </Button>
              ) : null}
              {canClear ? (
                <Button variant="ghost" icon={Trash2} disabled={busy && action !== 'start'} onClick={() => { setConfirmingClear(true) }}>{t('clear')}</Button>
              ) : null}
            </div>
          ) : null}

          <p className="sectionMeta">{t('updatedMeta', { value: view.updatedAt })} · {t('sectionMeta')}</p>
        </div>
      )}
      <ConfirmDialog
        open={confirmingClear}
        title={t('clearConfirmTitle')}
        description={t('clearConfirmDescription')}
        confirmLabel={t('clearConfirmAction')}
        pending={busy && action !== 'start'}
        onClose={() => { setConfirmingClear(false) }}
        onConfirm={() => {
          setConfirmingClear(false)
          void run('clear', () => tunnelAccessAction({ action: 'clear' }), t('noticeCleared'), () => {
            setHostname(''); setDomain(''); setApiToken('')
          })
        }}
      />
    </Section>
  )
}
