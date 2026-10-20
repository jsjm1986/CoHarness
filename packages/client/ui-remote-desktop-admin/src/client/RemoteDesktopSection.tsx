/** Remote-desktop administration settings section: grant table, issue form, and audit list. */
import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RemoteDesktopGrantInputView, RemoteDesktopLevelView,
} from '@deepseek-ai/dsh-api-remote-desktop-controller/types'
import type { RemoteDesktopAdminState } from './admin-store.ts'
import type { en } from './locales.ts'
import css from './RemoteDesktopSection.module.css'

/** Values the section's components receive through the inject face. */
export interface RemoteDesktopAdminInjected {
  readonly hooks: { readonly admin: HostObservable<RemoteDesktopAdminState> }
  readonly t: (key: keyof typeof en, params?: Record<string, string>) => string
  readonly refresh: (includeRevoked: boolean, signal: AbortSignal) => Promise<void>
  readonly grant: (input: RemoteDesktopGrantInputView, signal: AbortSignal) => Promise<void>
  readonly revoke: (grantId: string, signal: AbortSignal) => Promise<void>
  readonly setLevel: (grantId: string, level: RemoteDesktopLevelView, signal: AbortSignal) => Promise<void>
}

type SectionProps = PropsRuntime<'settings.section'> & InjectFace<RemoteDesktopAdminInjected>

const fmt = (at: number): string => new Date(at).toLocaleString()

/**
 * Render the grant administration surface: rows, issue form, and audit tail.
 * @param props - framework runtime, injected commands and state, localized copy.
 * @returns the remote-desktop administration section.
 */
export function RemoteDesktopSection(props: SectionProps): ReactNode {
  const { refresh, grant, revoke, setLevel, useAdmin, t } = props
  const state = useAdmin(snapshot => snapshot)
  const [includeRevoked, setIncludeRevoked] = useState(false)
  const [draft, setDraft] = useState({
    nodeId: '', desktop: '', principal: '', level: 'view' as RemoteDesktopLevelView,
    scope: 'machine' as 'machine' | 'session', sessionId: '', expiresAt: '', recording: false,
  })

  useEffect(() => {
    const gate = new AbortController()
    void refresh(includeRevoked, gate.signal)
    return () => { gate.abort(new Error('remote-desktop admin unmounted')) }
  }, [refresh, includeRevoked])

  const errorText = state.error === 'sessionRequired' ? t('sessionRequired')
    : state.error === undefined ? undefined
      : t('failed').replace('{message}', state.error)

  return (
    <section className={css.section}>
      <h2 className={css.heading}>{t('heading')}</h2>
      {errorText !== undefined && <p className={css.error}>{errorText}</p>}
      <div className={css.toolbar}>
        <label className={css.check}>
          <input type="checkbox" checked={includeRevoked} onChange={(event) => { setIncludeRevoked(event.currentTarget.checked) }} />
          {t('includeRevoked')}
        </label>
      </div>

      <h3 className={css.subheading}>{t('issueTitle')}</h3>
      <form className={css.form} onSubmit={(event) => {
        event.preventDefault()
        const gate = new AbortController()
        const input: RemoteDesktopGrantInputView = {
          target: { nodeId: draft.nodeId.trim(), ...(draft.desktop.trim() === '' ? {} : { desktop: draft.desktop.trim() }) },
          principal: draft.principal.trim(),
          level: draft.level,
          scope: draft.scope === 'machine'
            ? { kind: 'machine' }
            : { kind: 'session', sessionId: draft.sessionId.trim(), expiresAt: Date.parse(draft.expiresAt) },
          recording: draft.recording,
        }
        void grant(input, gate.signal)
      }}>
        <input className={css.field} required placeholder={t('nodeId')} value={draft.nodeId}
          onChange={(event) => { setDraft({ ...draft, nodeId: event.currentTarget.value }) }} />
        <input className={css.field} placeholder={t('desktop')} value={draft.desktop}
          onChange={(event) => { setDraft({ ...draft, desktop: event.currentTarget.value }) }} />
        <input className={css.field} required placeholder={t('principal')} value={draft.principal}
          onChange={(event) => { setDraft({ ...draft, principal: event.currentTarget.value }) }} />
        <select className={css.field} value={draft.level}
          onChange={(event) => { setDraft({ ...draft, level: event.currentTarget.value as RemoteDesktopLevelView }) }}>
          <option value="view">{t('view')}</option>
          <option value="control">{t('control')}</option>
        </select>
        <select className={css.field} value={draft.scope}
          onChange={(event) => { setDraft({ ...draft, scope: event.currentTarget.value as 'machine' | 'session' }) }}>
          <option value="machine">{t('machine')}</option>
          <option value="session">{t('session')}</option>
        </select>
        {draft.scope === 'session' && <>
          <input className={css.field} required placeholder={`${t('session')} id`} value={draft.sessionId}
            onChange={(event) => { setDraft({ ...draft, sessionId: event.currentTarget.value }) }} />
          <input className={css.field} required type="datetime-local" aria-label={t('expiresAt')} value={draft.expiresAt}
            onChange={(event) => { setDraft({ ...draft, expiresAt: event.currentTarget.value }) }} />
        </>}
        <label className={css.check}>
          <input type="checkbox" checked={draft.recording}
            onChange={(event) => { setDraft({ ...draft, recording: event.currentTarget.checked }) }} />
          {t('recording')}
        </label>
        <button type="submit" className={css.action} disabled={state.busy}>{state.busy ? t('issuing') : t('issue')}</button>
      </form>

      <h3 className={css.subheading}>{t('grants')}</h3>
      {state.loading ? <p className={css.note}>{t('loading')}</p> : state.grants.length === 0 ? <p className={css.note}>{t('empty')}</p> : (
        <table className={css.table}>
          <thead><tr>
            <th>{t('nodeId')}</th><th>{t('desktop')}</th><th>{t('principal')}</th><th>{t('level')}</th>
            <th>{t('scope')}</th><th>{t('recording')}</th><th>{t('grantedBy')}</th><th>{t('createdAt')}</th><th>{t('actions')}</th>
          </tr></thead>
          <tbody>
            {state.grants.map(row => (
              <tr key={row.id} className={row.revokedAt === undefined ? '' : css.revoked}>
                <td>{row.target.nodeId}</td>
                <td>{row.target.desktop ?? '—'}</td>
                <td>{row.principal}</td>
                <td>{row.level === 'control' ? t('control') : t('view')}</td>
                <td>{row.scope.kind === 'machine' ? t('machine') : `${t('session')} · ${fmt(row.scope.expiresAt)}`}</td>
                <td>{row.recording ? '●' : '—'}</td>
                <td>{row.grantedBy}</td>
                <td>{fmt(row.createdAt)}</td>
                <td>{row.revokedAt === undefined && (
                  <span className={css.rowActions}>
                    <button type="button" className={css.link} disabled={state.busy}
                      onClick={() => void setLevel(row.id, row.level === 'control' ? 'view' : 'control', new AbortController().signal)}>
                      {row.level === 'control' ? t('setView') : t('setControl')}
                    </button>
                    <button type="button" className={css.link} disabled={state.busy}
                      onClick={() => void revoke(row.id, new AbortController().signal)}>{t('revoke')}</button>
                  </span>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className={css.subheading}>{t('audit')}</h3>
      {state.audit.length === 0 ? <p className={css.note}>{t('auditEmpty')}</p> : (
        <table className={css.table}>
          <thead><tr><th>{t('colAt')}</th><th>{t('colKind')}</th><th>{t('colPrincipal')}</th><th>{t('colTarget')}</th><th>{t('colLevel')}</th></tr></thead>
          <tbody>
            {state.audit.map((event, index) => (
              <tr key={index}>
                <td>{fmt(event.at)}</td>
                <td>{event.kind}</td>
                <td>{event.principal}</td>
                <td>{event.target === undefined ? '—' : event.target.nodeId}</td>
                <td>{event.level ?? event.to ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
