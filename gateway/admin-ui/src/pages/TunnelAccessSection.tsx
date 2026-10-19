/** Public-access tunnel: cloudflared installation, one-click quick links, and the own-domain named tunnel. */
import { useCallback, useEffect, useMemo, useState } from 'react'
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

export function TunnelAccessSection() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  const [view, setView] = useState<TunnelAccessView | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [acting, setActing] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [hostname, setHostname] = useState('')
  const [domain, setDomain] = useState('')
  const [apiToken, setApiToken] = useState('')

  const refresh = useCallback(async () => {
    try {
      setView(await getTunnelAccess())
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    if (view?.hostname !== null && view?.hostname !== undefined && hostname === '') setHostname(view.hostname)
    if (view?.domain !== null && view?.domain !== undefined && domain === '') setDomain(view.domain)
  }, [view, hostname, domain])

  const run = async (work: () => Promise<TunnelAccessView>, ok: string) => {
    setActing(true)
    setError('')
    setNotice('')
    try {
      setView(await work())
      setNotice(ok)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setActing(false)
    }
  }

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url).catch(() => {})
    setNotice(t('noticeCopied'))
  }

  const state = view === null ? null : STATE_LABEL[view.state]
  const editable = view !== null && view.state !== 'starting' && view.state !== 'running'

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
      {view === null ? <LoadingState label={t('loadingTunnel')} /> : (
        <div className="tunnelAccess">
          <ErrorBanner message={error} />
          {notice === '' ? null : <p role="status">{notice}</p>}

          {!view.supported ? <p>{t('unsupportedPlatform')}</p> : null}

          {view.binary === null ? (
            <div className="tunnelBinary">
              <p>{t('binaryMissing')}</p>
              <Button
                variant="primary"
                icon={Download}
                loading={acting}
                onClick={() => void run(() => installTunnelBinary(), t('noticeInstalled'))}
              >
                {acting ? t('installingBinary') : t('installBinary')}
              </Button>
            </div>
          ) : (
            <p className="sectionMeta">
              {t('binaryPresent', { version: view.binary.version ?? t('binaryVersionUnknown'), path: view.binary.path })}
            </p>
          )}

          {view.state === 'running' && view.publicUrl !== null ? (
            <div className="tunnelRunning">
              <Field label={t('publicUrlLabel')}>
                <div className="tunnelUrl">
                  <a href={view.publicUrl} target="_blank" rel="noreferrer">{view.publicUrl}<ExternalLink aria-hidden="true" /></a>
                  <Button icon={Copy} onClick={() => void copyLink(view.publicUrl ?? '')}>{t('copyLink')}</Button>
                </div>
              </Field>
              <p className="fieldHint">{t('publicWarning')}</p>
              <div className="tunnelActions">
                <Button icon={Square} loading={acting} onClick={() => void run(() => tunnelAccessAction({ action: 'stop' }), t('noticeStopped'))}>
                  {t('stop')}
                </Button>
                {view.mode === 'named' ? (
                  <Button variant="ghost" icon={Trash2} onClick={() => { setConfirmingClear(true) }}>{t('clear')}</Button>
                ) : null}
              </div>
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
                  loading={acting}
                  onClick={() => void run(() => tunnelAccessAction({ action: 'start-quick' }), t('noticeStarted'))}
                >
                  {t('startQuick')}
                </Button>
              </div>
              <div className="tunnelChoice">
                <h3><Globe aria-hidden="true" /> {t('namedTitle')}</h3>
                <p>{t('namedDescription')}</p>
                <Field label={t('fieldHostname')}>
                  <input className="input" value={hostname} onChange={event => { setHostname(event.target.value) }} placeholder={t('placeholderHostname')} />
                </Field>
                <Field label={t('fieldDomain')}>
                  <input className="input" value={domain} onChange={event => { setDomain(event.target.value) }} placeholder={t('placeholderDomain')} />
                </Field>
                <Field
                  label={t('fieldApiToken')}
                  hint={view.apiTokenConfigured ? t('apiTokenStored') : t('hintApiToken')}
                >
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={apiToken}
                    onChange={event => { setApiToken(event.target.value) }}
                    placeholder={t('placeholderApiToken')}
                  />
                </Field>
                <Button
                  loading={acting}
                  disabled={hostname.trim() === ''}
                  onClick={() => void run(() => tunnelAccessAction({
                    action: 'start-named',
                    hostname: hostname.trim(),
                    ...(domain.trim() === '' ? {} : { domain: domain.trim() }),
                    ...(apiToken === '' ? {} : { apiToken }),
                  }), t('noticeStarted'))}
                >
                  {t('startNamed')}
                </Button>
              </div>
            </div>
          ) : null}

          {view.state === 'stopped' && view.mode !== 'off' ? (
            <div className="tunnelActions">
              {view.mode === 'named' ? (
                <Button variant="ghost" icon={Trash2} onClick={() => { setConfirmingClear(true) }}>{t('clear')}</Button>
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
        pending={acting}
        onClose={() => { setConfirmingClear(false) }}
        onConfirm={() => {
          setConfirmingClear(false)
          void run(() => tunnelAccessAction({ action: 'clear' }), t('noticeCleared'))
        }}
      />
    </Section>
  )
}
