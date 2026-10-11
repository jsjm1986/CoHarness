/** Maintenance-space admission management: admin-layered grants, space state, and member table. */
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getStewardOverview,
  setStewardPolicy,
  type StewardAccessEntry,
  type StewardOverview,
} from '../api.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
  Switch,
} from '../components/ui.tsx'
import { AccountBadge, Definition, RoleBadge, UserIdentity } from '../components/users.tsx'
import { adminLanguage, translateCopy, type CopyTranslate } from '../language.ts'
import { zh, en, type StewardCopyKey } from './steward.copy.ts'

type PendingGrant = { entry: StewardAccessEntry; grant: boolean }

const RUNTIME_TONE: Record<string, 'success' | 'info' | 'neutral' | 'danger'> = {
  ready: 'success',
  starting: 'info',
  stopped: 'neutral',
  error: 'danger',
}

const RUNTIME_LABEL: Record<string, StewardCopyKey> = {
  ready: 'runtimeReady',
  starting: 'runtimeStarting',
  stopped: 'runtimeStopped',
  error: 'runtimeError',
}

export function StewardPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [overview, setOverview] = useState<StewardOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<PendingGrant | null>(null)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)

  const reload = useCallback(async (showLoading = false) => {
    const attempt = ++generation.current
    if (showLoading) setLoading(true)
    try {
      const next = await getStewardOverview()
      if (attempt !== generation.current) return
      setOverview(next)
      setError('')
    } catch (cause) {
      if (attempt === generation.current) {
        setError(cause instanceof Error ? cause.message : t('operationFailed'))
      }
    } finally {
      if (attempt === generation.current) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void reload(true)
    return () => { generation.current++ }
  }, [reload])

  async function confirmGrant() {
    if (pending === null || saving) return
    const { entry, grant } = pending
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await setStewardPolicy({ kind: 'user', id: entry.userId, enabled: grant, revision: entry.revision })
      await reload()
      setNotice(grant ? t('noticeGranted', { name: entry.username }) : t('noticeRevoked', { name: entry.username }))
      setPending(null)
    } catch (cause) {
      setError(t('grantRejected', { error: cause instanceof Error ? cause.message : t('operationFailed') }))
    } finally {
      setSaving(false)
    }
  }

  const members = overview?.members ?? []
  const effectiveCount = members.filter(entry => entry.effective).length

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={overview === null ? undefined : (
          <StatusBadge tone={overview.enabled ? 'success' : 'neutral'}>{overview.enabled ? t('enabled') : t('disabled')}</StatusBadge>
        )}
        actions={<Button icon={RefreshCw} loading={loading && overview !== null} onClick={() => void reload()}>{t('refresh')}</Button>}
      />
      <ErrorBanner message={error} />
      {notice === '' ? null : <p role="status">{notice}</p>}

      <Section title={t('sectionRules')}>
        <ul className="ruleList">
          <li>{t('ruleAdmin')}</li>
          <li>{t('ruleGrant')}</li>
          <li>{t('ruleRevoke')}</li>
          <li>{t('ruleAudit')}</li>
        </ul>
      </Section>

      <Section title={t('sectionSpace')}>
        {overview === null ? (loading ? <LoadingState label={t('loading')} /> : null)
          : !overview.enabled ? <p className="muted">{t('spaceDisabled')}</p>
          : overview.space === null ? <p className="muted">{t('spaceMissing')}</p>
          : (
            <dl className="definitionGrid">
              <Definition label={t('spaceName')}><span>{overview.space.name}</span></Definition>
              <Definition label={t('spacePath')}><span className="codeText">{overview.space.path}</span></Definition>
              <Definition label={t('spaceRuntime')}>
                <StatusBadge tone={RUNTIME_TONE[overview.space.runtime] ?? 'neutral'}>
                  {runtimeLabel(overview.space.runtime, t)}
                </StatusBadge>
              </Definition>
            </dl>
          )}
      </Section>

      <Section
        flush
        className="responsiveSection"
        title={t('sectionMembers')}
        meta={overview === null ? undefined : t('membersMeta', { count: String(members.length), effective: String(effectiveCount) })}
      >
        {loading && overview === null ? <LoadingState label={t('loading')} /> : members.length === 0 ? (
          <EmptyState icon={ShieldCheck} title={t('emptyTitle')} detail={t('emptyDetail')} />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>{t('colUser')}</th>
                    <th>{t('colRole')}</th>
                    <th>{t('colGrant')}</th>
                    <th>{t('colEffective')}</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map(entry => (
                    <MemberRow
                      key={entry.userId}
                      entry={entry}
                      busy={saving}
                      onToggle={next => setPending({ entry, grant: next })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {members.map(entry => (
                <MemberCard
                  key={entry.userId}
                  entry={entry}
                  busy={saving}
                  onToggle={next => setPending({ entry, grant: next })}
                />
              ))}
            </div>
          </>
        )}
      </Section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.grant === false ? t('revokeTitle') : t('grantTitle')}
        description={pending === null ? '' : t(pending.grant ? 'grantDetail' : 'revokeDetail', { name: pending.entry.displayName || pending.entry.username })}
        confirmLabel={pending?.grant === false ? t('confirmRevoke') : t('confirmGrant')}
        pending={saving}
        onConfirm={() => void confirmGrant()}
        onClose={() => { if (!saving) setPending(null) }}
      />
    </div>
  )
}

function runtimeLabel(runtime: string, t: CopyTranslate<StewardCopyKey>) {
  const key = RUNTIME_LABEL[runtime]
  return key === undefined ? runtime : t(key)
}

function admissionBadge(entry: StewardAccessEntry, t: CopyTranslate<StewardCopyKey>) {
  if (entry.effective) return <StatusBadge tone="success">{t('effectiveYes')}</StatusBadge>
  if (entry.qualified) return <StatusBadge tone="warning">{t('effectiveStale')}</StatusBadge>
  return <StatusBadge tone="neutral">{t('effectiveNo')}</StatusBadge>
}

function grantControl(entry: StewardAccessEntry, busy: boolean, onToggle: (next: boolean) => void, t: CopyTranslate<StewardCopyKey>) {
  const name = entry.displayName || entry.username
  if (!entry.grantable) {
    return entry.qualified
      ? <Button type="button" variant="secondary" disabled={busy} title={t('staleDetail')} onClick={() => onToggle(false)}>{t('clearStale')}</Button>
      : <span className="muted">{t('requiresAdmin')}</span>
  }
  return (
    <Switch
      checked={entry.qualified}
      disabled={busy}
      ariaLabel={entry.qualified ? t('revokeFor', { name }) : t('grantFor', { name })}
      onChange={onToggle}
    />
  )
}

function MemberRow({ entry, busy, onToggle }: {
  entry: StewardAccessEntry
  busy: boolean
  onToggle: (next: boolean) => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return (
    <tr>
      <td>
        <Link className="userLink" to={`/users/${entry.userId}`}>
          <UserIdentity user={{ id: entry.userId, username: entry.username, displayName: entry.displayName }} />
        </Link>
      </td>
      <td>
        <span className="pageBadges">
          <RoleBadge role={entry.role === 'admin' ? 'admin' : 'user'} />
          {entry.membershipStatus === 'active' && entry.userStatus === 'active' ? null : <AccountBadge status="disabled" />}
        </span>
      </td>
      <td>{grantControl(entry, busy, onToggle, t)}</td>
      <td>{admissionBadge(entry, t)}</td>
    </tr>
  )
}

function MemberCard({ entry, busy, onToggle }: {
  entry: StewardAccessEntry
  busy: boolean
  onToggle: (next: boolean) => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return (
    <article className="mobileItem">
      <div className="mobileItemHeader">
        <Link className="userLink" to={`/users/${entry.userId}`}>
          <UserIdentity user={{ id: entry.userId, username: entry.username, displayName: entry.displayName }} />
        </Link>
        {admissionBadge(entry, t)}
      </div>
      <div className="mobileItemBody">
        <dl className="definitionGrid">
          <Definition label={t('colRole')}><RoleBadge role={entry.role === 'admin' ? 'admin' : 'user'} /></Definition>
          <Definition label={t('colGrant')}>{grantControl(entry, busy, onToggle, t)}</Definition>
        </dl>
      </div>
    </article>
  )
}
