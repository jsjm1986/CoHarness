/** Compact trajectory presenter: one primary line plus a metadata line per event. */

import type { ReactNode } from 'react'
import {
  IconChevronRightOutline14,
  IconSettingsOutline16,
  IconSparkle16,
  IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TrajectoryCellKind, TrajectoryCellProps } from './trajectory-record.ts'
import {
  formatElapsedSeconds, trajectoryDisplayHead, trajectoryRecordId,
  trajectoryRecordState, trajectoryStatusLabel,
} from './trajectory-record.ts'
import { CompactedIcon, InformationIcon } from './trajectory-kind-icons.tsx'
import { trajectoryPreviewText } from './trajectory-preview.ts'
import type { TrajectoryKey, TrajectoryTranslate } from './locales.ts'
import css from './TrajectoryMobileFeed.module.css'

/** Minimal record projection consumed by the compact event feed. */
export interface TrajectoryMobileRecord {
  turn: number | null
  section: number
  group: string
  groupStart: boolean
  turnStart: boolean
  cell: TrajectoryCellProps
  turnEnd: boolean
  collapsedSummary?: string
  collapsedSummaryKind?: 'turn' | 'assistant'
}

/** Request metadata needed by the compact boundary control. */
export interface TrajectoryMobileRequestInfo {
  number: number
  status?: 'complete' | 'running' | 'error'
  purpose?: 'assistant' | 'compaction'
  seq?: number
}

/** One visible or separator entry in the compact feed. */
export interface TrajectoryMobileFeedItem {
  record: TrajectoryMobileRecord
  position: number
  request?: number
  requestInfo?: TrajectoryMobileRequestInfo
  requestSelected: boolean
  terminalRequestBoundary: boolean
}

/** Request identity passed back to the ledger controller. */
export interface TrajectoryMobileRequestSelection {
  turn: number | null
  group: string
  seq?: number
}

/** Compact feed presenter props. */
export interface TrajectoryMobileFeedProps {
  /** Trajectory locale seat. */
  t: TrajectoryTranslate
  items: readonly TrajectoryMobileFeedItem[]
  logicalCount: number
  scrollReady: boolean
  virtualTop: number
  virtualBottom: number
  historyLoading: boolean
  olderBusy: boolean
  hasOlderRecords: boolean
  onLoadOlder?: () => void
  selectedIndex: number | null
  timelineFocusIndexes: ReadonlySet<number> | null
  onRecordSelect: (index: number) => void
  onRequestSelect: (request: TrajectoryMobileRequestSelection) => void
  onToggleTurn: (turn: number) => void
  onToggleAssistant: (id: string) => void
}

const KIND_LABEL_KEY: Record<TrajectoryCellKind, TrajectoryKey> = {
  system: 'kind.system',
  user: 'kind.user',
  context: 'kind.context',
  compacted: 'kind.compacted',
  message: 'kind.assistant',
  tool: 'kind.tool',
  subtool: 'kind.subtool',
}

function ToolIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" />
    </svg>
  )
}

function kindIcon(kind: TrajectoryCellKind): ReactNode {
  switch (kind) {
    case 'system': return <IconSettingsOutline16 size={16} />
    case 'user': return <IconUserOutline16 size={16} />
    case 'context': return <InformationIcon size={16} />
    case 'compacted': return <CompactedIcon size={16} />
    case 'message': return <IconSparkle16 size={16} />
    case 'tool':
    case 'subtool': return <ToolIcon />
  }
}

function displayText(cell: TrajectoryCellProps): string {
  const head = trajectoryDisplayHead(cell)
  if (head !== undefined) return head
  const markdown = cell.kind === 'user' || cell.kind === 'context'
    ? cell.inputDetail
    : cell.kind === 'message' || cell.kind === 'compacted'
      ? cell.outputDetail ?? cell.thinkingDetail
      : undefined
  return markdown === undefined ? '' : trajectoryPreviewText(markdown)
}

function resultText(cell: TrajectoryCellProps): string | undefined {
  return cell.resultPreviewMarkdown === undefined
    ? cell.result
    : trajectoryPreviewText(cell.resultPreviewMarkdown)
}

function titleOf(record: TrajectoryMobileRecord): string {
  if (record.collapsedSummary !== undefined) return record.collapsedSummary
  const text = displayText(record.cell)
  if ((record.cell.kind === 'tool' || record.cell.kind === 'subtool') && text !== '') {
    return text.split(' · ', 1)[0] ?? text
  }
  if (text !== '') return text
  return '—'
}

function timeLabel(cell: TrajectoryCellProps): string | undefined {
  if (cell.startedAt === null || cell.startedAt === undefined || !Number.isFinite(cell.startedAt)) {
    return undefined
  }
  return new Date(cell.startedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function requestLabel(item: TrajectoryMobileFeedItem, t: TrajectoryTranslate): string | undefined {
  if (item.request === undefined) return undefined
  return t(item.requestInfo?.purpose === 'compaction' ? 'request.labelCompaction' : 'request.label', {
    request: item.request,
  })
}

function turnLabel(record: TrajectoryMobileRecord): string | undefined {
  if (!record.turnStart || record.turn === null) return undefined
  return `#${record.turn}`
}

function itemClass(item: TrajectoryMobileFeedItem, selected: boolean, outside: boolean): string {
  const classes = [css.item]
  if (selected) classes.push(css.itemSelected)
  if (outside) classes.push(css.itemOutside)
  if (item.record.collapsedSummaryKind !== undefined) classes.push(css.itemSummary)
  if (item.record.cell.isError) classes.push(css.itemError)
  if (trajectoryRecordState(item.record) === 'running') classes.push(css.itemRunning)
  return classes.join(' ')
}

function requestMarkerClass(item: TrajectoryMobileFeedItem): string {
  return item.requestSelected
    ? `${css.requestMarker} ${css.requestMarkerActive}`
    : css.requestMarker ?? ''
}

/** Render one compact event stream while keeping the ledger controller in the parent. */
export function TrajectoryMobileFeed({
  t,
  items,
  logicalCount,
  scrollReady,
  virtualTop,
  virtualBottom,
  historyLoading,
  olderBusy,
  hasOlderRecords,
  onLoadOlder,
  selectedIndex,
  timelineFocusIndexes,
  onRecordSelect,
  onRequestSelect,
  onToggleTurn,
  onToggleAssistant,
}: TrajectoryMobileFeedProps): ReactNode {
  return (
    <div
      className={css.feed}
      data-trajectory-feed=""
      data-scroll-ready={scrollReady || undefined}
      role="list"
      aria-label={t('feed.aria')}
      aria-setsize={logicalCount}
    >
      {historyLoading && (
        <div className={css.loading} role="status" aria-live="polite">
          <span className={css.spinner} aria-hidden="true" />
          {t('history.loadingTrajectory')}
        </div>
      )}
      {hasOlderRecords && (
        <div className={css.historyRow} data-history-load="">
          <button
            type="button"
            className={css.historyButton}
            disabled={olderBusy || onLoadOlder === undefined}
            onClick={onLoadOlder}
          >
            {olderBusy ? t('history.loadingEarlier') : t('history.loadEarlier')}
          </button>
        </div>
      )}
      {virtualTop > 0 && <div className={css.virtualSpacer} style={{ height: virtualTop }} aria-hidden="true" />}
      {items.map((item) => {
        const record = item.record
        const request = requestLabel(item, t)
        const state = trajectoryRecordState(record)
        const selected = selectedIndex === record.cell.index
        const outside = timelineFocusIndexes !== null
          && record.collapsedSummaryKind === undefined
          && !timelineFocusIndexes.has(record.cell.index)
        if (record.cell.requestOnly === true) {
          return (
            <div
              key={`${trajectoryRecordId(record.cell)}-boundary`}
              className={css.boundary}
              data-trajectory-row-key={trajectoryRecordId(record.cell)}
              aria-hidden="true"
            />
          )
        }
        const result = resultText(record.cell)
        const time = timeLabel(record.cell)
        const duration = formatElapsedSeconds(record.cell.timeSeconds, t)
        const turn = turnLabel(record)
        const ariaLabel = [
          request,
          t(KIND_LABEL_KEY[record.cell.kind]),
          titleOf(record),
          trajectoryStatusLabel(state, t),
          duration === '—' ? undefined : duration,
          time,
        ].filter(value => value !== undefined && value !== '').join(', ')
        const summary = record.collapsedSummaryKind !== undefined
        return (
          <div
            key={trajectoryRecordId(record.cell) + (summary ? `-${record.collapsedSummaryKind}` : '')}
            className={itemClass(item, selected, outside)}
            data-trajectory-row-key={trajectoryRecordId(record.cell)}
            data-record-index={record.cell.index}
            data-kind={record.cell.kind}
            data-selected={selected || undefined}
            data-running={state === 'running' || undefined}
            data-error={state === 'error' || undefined}
            data-timeline-focus={timelineFocusIndexes === null
              ? undefined
              : outside ? 'outside' : 'inside'}
            data-collapsed-summary={record.collapsedSummaryKind}
            role="listitem"
            aria-selected={selected}
            aria-setsize={logicalCount}
            aria-posinset={item.position + 1}
          >
            {request !== undefined && (
              <button
                type="button"
                className={requestMarkerClass(item)}
                aria-label={request}
                aria-pressed={item.requestSelected}
                onClick={(event) => {
                  event.stopPropagation()
                  onRequestSelect({
                    turn: record.turn,
                    group: record.group,
                    ...(item.requestInfo?.seq === undefined ? {} : { seq: item.requestInfo.seq }),
                  })
                }}
              >
                <span aria-hidden="true">{item.request}</span>
              </button>
            )}
            <button
              type="button"
              className={css.rowButton}
              aria-label={ariaLabel}
              aria-pressed={selected}
              onClick={() => {
                if (summary) {
                  if (record.collapsedSummaryKind === 'turn' && record.turn !== null) onToggleTurn(record.turn)
                  else onToggleAssistant(trajectoryRecordId(record.cell))
                } else onRecordSelect(record.cell.index)
              }}
            >
              <span className={css.iconRail} aria-hidden="true">
                {turn !== undefined && <span className={css.turnBadge}>{turn}</span>}
                <span className={`${css.kindIcon} ${css[`kind${record.cell.kind}`]}`}>
                  {kindIcon(record.cell.kind)}
                </span>
              </span>
              <span className={css.copy}>
                <span className={css.primaryLine}>
                  <span className={css.kindLabel}>{t(KIND_LABEL_KEY[record.cell.kind])}</span>
                  <span className={css.title} title={titleOf(record)}>{titleOf(record)}</span>
                </span>
                <span className={css.metaLine}>
                  <span className={`${css.statusDot} ${css[`status${state}`]}`} aria-hidden="true" />
                  <span>{trajectoryStatusLabel(state, t)}</span>
                  {duration !== '—' && <span>· {duration}</span>}
                  {time !== undefined && <span>· {time}</span>}
                  {result !== undefined && result !== '' && !summary && (
                    <span className={css.result} title={result}>· {result}</span>
                  )}
                </span>
              </span>
              <IconChevronRightOutline14 className={css.chevron} size={14} aria-hidden="true" />
            </button>
          </div>
        )
      })}
      {virtualBottom > 0 && <div className={css.virtualSpacer} style={{ height: virtualBottom }} aria-hidden="true" />}
    </div>
  )
}
