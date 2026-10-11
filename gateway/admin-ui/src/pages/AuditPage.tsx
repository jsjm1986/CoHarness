import { ChevronLeft, ChevronRight, Filter, RotateCcw, ScrollText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { listAudit, type AuditEntry, type AuditFamily, type AuditFilter } from '../api.ts'
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as auditZh, en as auditEn, type AuditCopyKey } from './audit.copy.ts'

const PAGE_SIZE = 50

type FilterDraft = {
  actor: string
  actionQuery: string
  outcome: '' | 'success' | 'failure'
  from: string
  to: string
}

const EMPTY_FILTER: FilterDraft = { actor: '', actionQuery: '', outcome: '', from: '', to: '' }

type FamilyKey = '' | AuditFamily

const FAMILY_TABS: { key: FamilyKey; label: AuditCopyKey }[] = [
  { key: '', label: 'familyAll' },
  { key: 'admin', label: 'familyAdmin' },
  { key: 'auth', label: 'familyAuth' },
  { key: 'model', label: 'familyModel' },
  { key: 'steward', label: 'familySteward' },
  { key: 'api', label: 'familyApi' },
]

function msFromDatetimeLocal(value: string): number | undefined {
  if (value === '') return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

function auditT() {
  return translateCopy(adminLanguage(), { zh: auditZh, en: auditEn })
}

export function AuditPage() {
  const t = useMemo(() => auditT(), [])
  const [rows, setRows] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [family, setFamily] = useState<FamilyKey>('')
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTER)
  const [activeFilter, setActiveFilter] = useState<FilterDraft>(EMPTY_FILTER)
  const [offset, setOffset] = useState(0)

  const fetchPage = useCallback(async (filter: FilterDraft, nextFamily: FamilyKey, nextOffset: number, showLoading = true) => {
    const apiFilter: AuditFilter = {
      actor: filter.actor === '' ? undefined : filter.actor,
      query: filter.actionQuery === '' ? undefined : filter.actionQuery,
      outcome: filter.outcome === '' ? undefined : filter.outcome,
      family: nextFamily === '' ? undefined : nextFamily,
      from: msFromDatetimeLocal(filter.from),
      to: msFromDatetimeLocal(filter.to),
      limit: PAGE_SIZE,
      offset: nextOffset,
    }
    if (showLoading) setLoading(true)
    try {
      const page = await listAudit(apiFilter)
      setRows(page.entries)
      setTotal(page.total)
      setOffset(nextOffset)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchPage(EMPTY_FILTER, '', 0) }, [fetchPage])

  function onFilter(event: FormEvent) {
    event.preventDefault()
    setActiveFilter(draft)
    void fetchPage(draft, family, 0)
  }

  function resetFilters() {
    setDraft(EMPTY_FILTER)
    setActiveFilter(EMPTY_FILTER)
    void fetchPage(EMPTY_FILTER, family, 0)
  }

  function selectFamily(next: FamilyKey) {
    setFamily(next)
    void fetchPage(activeFilter, next, 0)
  }

  const hasFilters = Object.values(activeFilter).some(value => value !== '')
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pageCount = total === null ? null : Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasNext = total === null ? rows.length === PAGE_SIZE : offset + PAGE_SIZE < total

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={hasFilters ? t('metaFiltered') : undefined}
        actions={(
          <div className="pageToolbar">
            <div className="segmented" role="group" aria-label={t('pageTitle')}>
              {FAMILY_TABS.map(tab => (
                <button key={tab.key} type="button" aria-pressed={family === tab.key} onClick={() => selectFamily(tab.key)}>{t(tab.label)}</button>
              ))}
            </div>
            <IconButton label={t('refresh')} icon={RotateCcw} variant="secondary" onClick={() => void fetchPage(activeFilter, family, offset)} />
          </div>
        )}
      />
      <ErrorBanner message={error} />
      <Section flush title={t('sectionFilters')}>
        <form className="filterPanel" onSubmit={onFilter}>
          <div className="filterGrid">
            <Field label={t('fieldActor')}>
              <input className="input" value={draft.actor} onChange={event => setDraft({ ...draft, actor: event.target.value })} placeholder={t('fieldActorPlaceholder')} />
            </Field>
            <Field label={t('fieldActionQuery')}>
              <input className="input codeText" value={draft.actionQuery} onChange={event => setDraft({ ...draft, actionQuery: event.target.value })} placeholder={t('fieldActionQueryPlaceholder')} />
            </Field>
            <Field label={t('fieldOutcome')}>
              <select className="input" value={draft.outcome} onChange={event => setDraft({ ...draft, outcome: event.target.value as FilterDraft['outcome'] })}>
                <option value="">{t('outcomeAll')}</option>
                <option value="success">{t('outcomeSuccess')}</option>
                <option value="failure">{t('outcomeFailure')}</option>
              </select>
            </Field>
            <Field label={t('fieldFrom')}>
              <input className="input" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} type="datetime-local" />
            </Field>
            <Field label={t('fieldTo')}>
              <input className="input" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} type="datetime-local" />
            </Field>
          </div>
          <div className="filterActions">
            <Button type="button" icon={RotateCcw} onClick={resetFilters} disabled={!Object.values(draft).some(value => value !== '') && !hasFilters}>{t('filterReset')}</Button>
            <Button type="submit" variant="primary" icon={Filter}>{t('filterApply')}</Button>
          </div>
        </form>
      </Section>
      <Section
        flush
        className="responsiveSection"
        title={t('eventsTitle')}
        meta={loading ? undefined : total === null
          ? t('pageIndicator', { page: String(page) })
          : `${t('totalRows', { total: String(total) })} · ${t('pageIndicator', { page: String(page) })}${pageCount === null ? '' : ` / ${String(pageCount)}`}`}
      >
        {loading ? <LoadingState label={t('loadingEvents')} /> : rows.length === 0 ? (
          <EmptyState icon={ScrollText} title={t('emptyTitle')} detail={hasFilters || family !== '' ? t('emptyDetailFiltered') : t('emptyDetail')} />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable auditTable">
                <thead><tr><th>{t('columnTime')}</th><th>{t('columnUser')}</th><th>{t('columnAction')}</th><th>{t('columnRequest')}</th><th>{t('columnResult')}</th><th>{t('columnMetadata')}</th><th>{t('columnIp')}</th></tr></thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id}>
                      <td><time className="auditTime" dateTime={new Date(row.ts).toISOString()}>{formatTime(row.ts)}</time></td>
                      <td><ActorCell row={row} /></td>
                      <td><span className="auditAction"><strong>{row.action}</strong><span>ID {row.id}</span></span></td>
                      <td><span className="pathText">{row.methodPath}</span></td>
                      <td><RequestResult row={row} /></td>
                      <td><AuditMetadata metadata={row.metadata} /></td>
                      <td><span className="codeText">{row.ip}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {rows.map(row => (
                <article className="mobileItem" key={row.id}>
                  <div className="mobileItemHeader">
                    <span className="auditAction"><strong>{row.action}</strong><span>{formatTime(row.ts)}</span></span>
                    <RequestResult row={row} />
                  </div>
                  <div className="mobileItemBody">
                    <span className="pathText">{row.methodPath}</span>
                    <dl className="definitionGrid">
                      <Definition label={t('columnUser')}><ActorName row={row} /></Definition>
                      <Definition label={t('columnIp')}><span className="codeText">{row.ip}</span></Definition>
                    </dl>
                    <AuditMetadata metadata={row.metadata} />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        {loading || (rows.length === 0 && offset === 0) ? null : (
          <div className="pagination">
            <span>{t('pageIndicator', { page: String(page) })}{pageCount === null ? '' : ` / ${String(pageCount)}`}</span>
            <IconButton label={t('pagePrev')} icon={ChevronLeft} variant="secondary" disabled={offset === 0} onClick={() => void fetchPage(activeFilter, family, Math.max(0, offset - PAGE_SIZE))} />
            <IconButton label={t('pageNext')} icon={ChevronRight} variant="secondary" disabled={!hasNext} onClick={() => void fetchPage(activeFilter, family, offset + PAGE_SIZE)} />
          </div>
        )}
      </Section>
    </div>
  )
}

function ActorName({ row }: { row: AuditEntry }) {
  const t = useMemo(() => auditT(), [])
  if (row.userId === null) return <>{t('systemActor')}</>
  if (row.username === null) return <>{t('removedUser')} #{row.userId}</>
  if (row.displayName !== null && row.displayName !== '' && row.displayName !== row.username) {
    return <>{row.displayName} <span className="muted">@{row.username}</span></>
  }
  return <>@{row.username}</>
}

function ActorCell({ row }: { row: AuditEntry }) {
  if (row.userId === null) return <span className="muted"><ActorName row={row} /></span>
  return <span><ActorName row={row} /></span>
}

const RESULT_LABEL_KEYS: Record<AuditEntry['outcome'], AuditCopyKey> = {
  success: 'resultSuccess', failure: 'resultFailure', recorded: 'resultRecorded', unknown: 'resultUnknown',
}

function RequestResult({ row }: { row: AuditEntry }) {
  const t = useMemo(() => auditT(), [])
  const tone = row.outcome === 'failure' ? 'danger' : row.outcome === 'success' ? 'success' : 'neutral'
  return <StatusBadge tone={tone}>{t(RESULT_LABEL_KEYS[row.outcome])}{row.status === null ? '' : ` · HTTP ${row.status}`}</StatusBadge>
}

const METADATA_LABEL_KEYS: Record<string, AuditCopyKey> = {
  id: 'metaId', targetId: 'metaTargetId', targetKind: 'metaTargetKind', userId: 'fieldActor', ownerUserId: 'metaOwnerUserId',
  projectId: 'metaProjectId', nodeId: 'metaNodeId', catalogId: 'metaCatalogId', rootSessionId: 'metaRootSessionId', sessionId: 'metaSessionId',
  grantId: 'metaGrantId', backupId: 'metaBackupId', operationId: 'metaOperationId', receiptId: 'metaReceiptId', redispatchId: 'metaRedispatchId',
  subjectId: 'metaSubjectId', subjectType: 'metaSubjectType', subjectKind: 'metaSubjectType', revision: 'metaRevision', generation: 'metaGeneration',
  count: 'metaCount', requested: 'metaRequested', succeeded: 'metaSucceeded', trashed: 'metaTrashed', opCount: 'metaOpCount',
  allowed: 'metaAllowed', shared: 'metaShared', enabled: 'metaEnabled', autoReviewEligible: 'metaAutoReviewEligible', terminalEnabled: 'metaTerminalEnabled',
  sshEligible: 'metaSshEligible', desktopEligible: 'metaDesktopEligible', status: 'metaStatus', state: 'metaState', mode: 'metaMode', role: 'metaRole', action: 'metaAction',
  username: 'metaUsername', model: 'metaModel', provider: 'metaProvider', purpose: 'metaPurpose',
  classification: 'metaClassification', rowCount: 'metaRowCount', resultBytes: 'metaResultBytes', dryRun: 'metaDryRun', approvalId: 'metaApprovalId',
  truncated: 'metaEnabled',
}

function AuditMetadata({ metadata }: Pick<AuditEntry, 'metadata'>) {
  const t = useMemo(() => auditT(), [])
  const entries = Object.entries(metadata)
  if (entries.length === 0) return <span className="muted">{t('noMetadata')}</span>
  return <dl className="definitionGrid">{entries.map(([key, value]) => {
    const labelKey = METADATA_LABEL_KEYS[key]
    return (
      <Definition key={key} label={labelKey === undefined ? key : t(labelKey)}>{typeof value === 'boolean' ? value ? t('yes') : t('no') : String(value)}</Definition>
    )
  })}</dl>
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(auditT()('dateLocale'), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
