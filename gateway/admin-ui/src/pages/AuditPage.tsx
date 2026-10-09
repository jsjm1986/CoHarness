import { ChevronLeft, ChevronRight, Filter, RotateCcw, ScrollText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { listAudit, type AuditEntry, type AuditFilter } from '../api.ts'
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
  userId: string
  actionPrefix: string
  from: string
  to: string
}

const EMPTY_FILTER: FilterDraft = { userId: '', actionPrefix: '', from: '', to: '' }

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTER)
  const [activeFilter, setActiveFilter] = useState<FilterDraft>(EMPTY_FILTER)
  const [offset, setOffset] = useState(0)

  const fetchPage = useCallback(async (filter: FilterDraft, nextOffset: number, showLoading = true) => {
    const parsedUserId = filter.userId === '' ? undefined : Number(filter.userId)
    if (parsedUserId !== undefined && (!Number.isInteger(parsedUserId) || parsedUserId <= 0)) {
      setError(t('errorUserIdInvalid'))
      return
    }
    const apiFilter: AuditFilter = {
      userId: parsedUserId,
      actionPrefix: filter.actionPrefix === '' ? undefined : filter.actionPrefix,
      from: msFromDatetimeLocal(filter.from),
      to: msFromDatetimeLocal(filter.to),
      limit: PAGE_SIZE,
      offset: nextOffset,
    }
    if (showLoading) setLoading(true)
    try {
      setRows(await listAudit(apiFilter))
      setOffset(nextOffset)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [t])

  useEffect(() => { void fetchPage(EMPTY_FILTER, 0) }, [fetchPage])

  function onFilter(event: FormEvent) {
    event.preventDefault()
    setActiveFilter(draft)
    void fetchPage(draft, 0)
  }

  function resetFilters() {
    setDraft(EMPTY_FILTER)
    setActiveFilter(EMPTY_FILTER)
    void fetchPage(EMPTY_FILTER, 0)
  }

  const hasFilters = Object.values(activeFilter).some(value => value !== '')
  const page = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={hasFilters ? t('metaFiltered') : undefined}
      />
      <ErrorBanner message={error} />
      <Section flush title={t('sectionFilters')}>
        <form className="filterPanel" onSubmit={onFilter}>
          <div className="filterGrid">
            <Field label={t('userIdLabel')}>
              <input className="input" value={draft.userId} onChange={event => setDraft({ ...draft, userId: event.target.value })} placeholder={t('userIdPlaceholder')} inputMode="numeric" />
            </Field>
            <Field label={t('fieldActionPrefix')}>
              <input className="input codeText" value={draft.actionPrefix} onChange={event => setDraft({ ...draft, actionPrefix: event.target.value })} placeholder={t('actionPrefixPlaceholder')} />
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
      <Section flush className="responsiveSection" title={t('eventsTitle')} meta={loading ? undefined : t('pageIndicator', { page: String(page) })}>
        {loading ? <LoadingState label={t('loadingEvents')} /> : rows.length === 0 ? (
          <EmptyState icon={ScrollText} title={t('emptyTitle')} detail={hasFilters ? t('emptyDetailFiltered') : t('emptyDetail')} />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable auditTable">
                <thead><tr><th>{t('columnTime')}</th><th>{t('columnUser')}</th><th>{t('columnAction')}</th><th>{t('columnRequest')}</th><th>{t('columnResult')}</th><th>{t('columnMetadata')}</th><th>{t('columnIp')}</th></tr></thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id}>
                      <td><time className="auditTime" dateTime={new Date(row.ts).toISOString()}>{formatTime(row.ts)}</time></td>
                      <td>{row.userId === null ? <span className="muted">{t('systemActor')}</span> : <span className="codeText">#{row.userId}</span>}</td>
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
                      <Definition label={t('columnUser')}>{row.userId === null ? t('systemActor') : `#${row.userId}`}</Definition>
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
            <span>{t('pageIndicator', { page: String(page) })}</span>
            <IconButton label={t('pagePrev')} icon={ChevronLeft} variant="secondary" disabled={offset === 0} onClick={() => void fetchPage(activeFilter, Math.max(0, offset - PAGE_SIZE))} />
            <IconButton label={t('pageNext')} icon={ChevronRight} variant="secondary" disabled={rows.length < PAGE_SIZE} onClick={() => void fetchPage(activeFilter, offset + PAGE_SIZE)} />
          </div>
        )}
      </Section>
    </div>
  )
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
  id: 'metaId', targetId: 'metaTargetId', targetKind: 'metaTargetKind', userId: 'userIdLabel', ownerUserId: 'metaOwnerUserId',
  projectId: 'metaProjectId', nodeId: 'metaNodeId', catalogId: 'metaCatalogId', rootSessionId: 'metaRootSessionId', sessionId: 'metaSessionId',
  grantId: 'metaGrantId', backupId: 'metaBackupId', operationId: 'metaOperationId', receiptId: 'metaReceiptId', redispatchId: 'metaRedispatchId',
  subjectId: 'metaSubjectId', subjectType: 'metaSubjectType', revision: 'metaRevision', generation: 'metaGeneration',
  count: 'metaCount', requested: 'metaRequested', succeeded: 'metaSucceeded', trashed: 'metaTrashed', opCount: 'metaOpCount',
  allowed: 'metaAllowed', shared: 'metaShared', enabled: 'metaEnabled', autoReviewEligible: 'metaAutoReviewEligible', terminalEnabled: 'metaTerminalEnabled',
  sshEligible: 'metaSshEligible', desktopEligible: 'metaDesktopEligible', status: 'metaStatus', state: 'metaState', mode: 'metaMode', role: 'metaRole', action: 'metaAction',
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
