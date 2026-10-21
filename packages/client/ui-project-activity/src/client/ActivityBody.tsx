/** Project activity panel: grouping toolbar over per-mode folded reading views. */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconCheckOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconQueueOutline14,
  IconRefreshOutline14,
  IconRightUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityGrouping, ActivityItem, ActivitySection } from './feed.ts'
import { agoLabel, convTone, dayLabel, feedMembers, groupItems, relativeDayLabel, timeLabel } from './feed.ts'
import type { ActivityStore } from './store.ts'
import css from './ActivityBody.module.css'

/** Injected business face built by apply over the tab's store and services. */
export interface ActivityInjected {
  /** Replace the feed with a fresh first page. */
  refresh: () => void
  /** Append the next older page when the feed is not exhausted. */
  loadMore: (before: string) => void
  /** Open a conversation pane, revealing the named event when `seq` is given. */
  reveal: (sessionId: string, seq: number | null) => void
}

/** Activity tab body props assembled by the tab seat. */
export type ActivityBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ActivityStore>
  & PropsLocale<'projectActivity'>
  & InjectFace<ActivityInjected>

type Translate = ActivityBodyProps['t']

const TONE_CLASS = [css.toneBlue, css.toneGreen, css.toneAmber, css.toneRed, css.toneDeep] as const

function toneClass(sessionId: string): string {
  return TONE_CLASS[convTone(sessionId)] ?? ''
}

function itemTitle(item: ActivityItem, t: Translate): string {
  return item.conversationTitle ?? t('row.untitledConversation')
}

/** Bubble marking a row as a plain message or a chosen answer. */
function TypeIcon({ kind }: { readonly kind: ActivityItem['kind'] }): ReactNode {
  return (
    <span className={kind === 'answer' ? css.ticoAns : css.ticoMsg} aria-hidden>
      {kind === 'answer' ? <IconCheckOutline14 /> : <IconQueueOutline14 />}
    </span>
  )
}

/** Coloured dot identifying one conversation across every view. */
function ConvDot({ sessionId }: { readonly sessionId: string }): ReactNode {
  return <span className={`${css.cdot} ${toneClass(sessionId)}`} aria-hidden />
}

/** Conversation chip: display plus open-without-anchor on click. */
function ConvChip({ item, reveal, t }: {
  readonly item: ActivityItem
  readonly reveal: ActivityInjected['reveal']
  readonly t: Translate
}): ReactNode {
  return (
    <button type="button" className={css.chip} title={t('row.openConversation')}
      onClick={(event) => { event.stopPropagation(); reveal(item.sessionId, null) }}>
      <ConvDot sessionId={item.sessionId} />
      <span className={css.chipLabel}>{itemTitle(item, t)}</span>
    </button>
  )
}

/** Full row shown inside an expanded section; clicking reveals the event. */
function ItemRow({ item, showConv, reveal, t }: {
  readonly item: ActivityItem
  readonly showConv: boolean
  readonly reveal: ActivityInjected['reveal']
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.xRow} role="button" tabIndex={0}
      title={t('row.reveal')}
      onClick={() => { reveal(item.sessionId, item.seq) }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') reveal(item.sessionId, item.seq) }}>
      <TypeIcon kind={item.kind} />
      <span className={css.xMain}>
        <span className={css.xMeta}>
          <span className={css.who}>{item.actorLabel}</span>
          {item.kind === 'answer' && <span className={css.verbAns}>{t('verb.decided')}</span>}
          {showConv && <ConvChip item={item} reveal={reveal} t={t} />}
          <span className={css.xTime}>{timeLabel(item.occurredAt)}</span>
        </span>
        {item.kind === 'answer' && item.questionText !== undefined && (
          <span className={css.xQ}>{t('row.questionLine', { question: item.questionText })}</span>
        )}
        {item.kind === 'answer'
          ? <span className={css.xAns}><IconCheckOutline14 />{item.text}</span>
          : <span className={css.xTxt}>{item.text}</span>}
      </span>
      <IconRightUpOutline14 className={css.jump} aria-hidden />
    </div>
  )
}

/** One line inside a day fold; clicking expands an inline detail, not navigation. */
function TimeEntry({ item, reveal, t }: {
  readonly item: ActivityItem
  readonly reveal: ActivityInjected['reveal']
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.tEntry}>
      <div className={css.tLine} role="button" tabIndex={0}
        title={open ? t('section.collapse') : t('section.expand')}
        onClick={() => { setOpen(!open) }}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setOpen(!open) }}>
        <TypeIcon kind={item.kind} />
        <span className={css.tWho}>{item.actorLabel}</span>
        <ConvChip item={item} reveal={reveal} t={t} />
        <span className={css.tGist}>
          {item.kind === 'answer'
            ? <><span className={css.verbAns}>{t('verb.decided')}</span>{' '}<b>{item.text}</b></>
            : item.text}
        </span>
        <span className={css.tTime}>{timeLabel(item.occurredAt)}</span>
      </div>
      {open && (
        <div className={css.tDetail}>
          {item.kind === 'answer' && item.questionText !== undefined && (
            <div className={css.detailQ}>{t('row.questionLine', { question: item.questionText })}</div>
          )}
          {item.kind === 'answer'
            ? <div className={css.detailAns}><IconCheckOutline14 />{item.text}</div>
            : <div className={css.detailText}>{item.text}</div>}
          <button type="button" className={css.goLink}
            onClick={() => { reveal(item.sessionId, item.seq) }}>
            {t('row.jumpToConversation')}<IconRightUpOutline14 />
          </button>
        </div>
      )}
    </div>
  )
}

/** Time mode: one collapsible fold per day, open by default only for today. */
function DaySection({ section, reveal, t }: {
  readonly section: ActivitySection
  readonly reveal: ActivityInjected['reveal']
  readonly t: Translate
}): ReactNode {
  const today = dayLabel(new Date().toISOString())
  const [open, setOpen] = useState(section.day === today)
  const label = section.day === undefined
    ? section.title
    : relativeDayLabel(section.day, { today: t('day.today'), yesterday: t('day.yesterday') })
  return (
    <div className={css.dayBlock}>
      <div className={css.dayHead} role="button" tabIndex={0}
        title={open ? t('section.collapse') : t('section.expand')}
        onClick={() => { setOpen(!open) }}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setOpen(!open) }}>
        <IconChevronRightOutline14 className={open ? css.chevOpen : css.chev} aria-hidden />
        <span className={css.dayTitle}>{label}</span>
        <span className={css.dayWho}>{section.actors.map(actor => actor.label).join(' · ')}</span>
        <span className={css.dayCnt}>{t('stats.entries', { count: section.rows.length })}</span>
      </div>
      {open && section.rows.map((item, index) => (
        <TimeEntry key={`${item.sessionId}:${String(item.seq ?? item.occurredAt)}:${String(index)}`}
          item={item} reveal={reveal} t={t} />
      ))}
    </div>
  )
}

/** Conversation mode: the folded block is the topic digest, answers first. */
function ConvBlock({ section, reveal, t }: {
  readonly section: ActivitySection
  readonly reveal: ActivityInjected['reveal']
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const digest = section.digest
  const ago = section.latest === undefined ? '' : agoLabel(section.latest, t('day.yesterday'))
  const sessionId = section.rows[0]?.sessionId ?? ''
  return (
    <div className={css.block}>
      <div className={css.blockHead} role="button" tabIndex={0}
        title={open ? t('section.collapse') : t('section.expand')}
        onClick={() => { setOpen(!open) }}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setOpen(!open) }}>
        <div className={css.blockTop}>
          <ConvDot sessionId={sessionId} />
          <IconChevronRightOutline14 className={open ? css.chevOpen : css.chev} aria-hidden />
          <span className={css.blockTitle}>{section.title}</span>
          <span className={css.ago}>{ago}</span>
        </div>
        {digest !== undefined && (
          <div className={css.digest}>
            {digest.kind === 'answer'
              ? t('digest.answerLine', {
                question: digest.questionText ?? t('row.unknownQuestion'),
                answer: digest.text,
                actor: digest.actorLabel,
              })
              : t('digest.messageLine', { actor: digest.actorLabel, text: digest.text })}
          </div>
        )}
        <div className={css.blockMeta}>
          <span className={css.avs} aria-hidden>
            {section.actors.slice(0, 3).map(actor => (
              <i key={actor.userId}>{actor.label.trim().charAt(0).toUpperCase() || '?'}</i>
            ))}
          </span>
          <span className={css.cnt}>{t('stats.entries', { count: section.rows.length })}</span>
          {section.answers > 0 && (
            <span className={css.dchip}><IconCheckOutline14 />{t('stats.decisions', { count: section.answers })}</span>
          )}
          {!open && <span className={css.ex}>{t('section.expand')}<IconChevronDownOutline14 /></span>}
        </div>
      </div>
      {open && (
        <div className={css.rows}>
          {section.rows.map((item, index) => (
            <ItemRow key={`${item.sessionId}:${String(item.seq ?? item.occurredAt)}:${String(index)}`}
              item={item} showConv={false} reveal={reveal} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Member mode: the folded block is the person digest — what they chose and said. */
function MemberBlock({ section, reveal, t }: {
  readonly section: ActivitySection
  readonly reveal: ActivityInjected['reveal']
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const answer = section.rows.find(row => row.kind === 'answer')
  const message = section.rows.find(row => row.kind === 'message')
  const initial = section.title.trim().charAt(0).toUpperCase() || '?'
  return (
    <div className={css.block}>
      <div className={css.blockHead} role="button" tabIndex={0}
        title={open ? t('section.collapse') : t('section.expand')}
        onClick={() => { setOpen(!open) }}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setOpen(!open) }}>
        <div className={css.memTop}>
          <span className={css.memAv} aria-hidden>{initial}</span>
          <span className={css.memName}>{section.title}</span>
          <span className={css.kpi}>
            {t('stats.entries', { count: section.rows.length })}
            {section.answers > 0 && <> · <span className={css.kpiAns}><IconCheckOutline14 />{t('stats.decided', { count: section.answers })}</span></>}
          </span>
          <IconChevronRightOutline14 className={open ? css.chevOpen : css.chev} aria-hidden />
        </div>
        <div className={css.mDigest}>
          {answer !== undefined && (
            <span className={css.dLine}>
              {t('member.answerDigest', {
                question: answer.questionText ?? t('row.unknownQuestion'),
                answer: answer.text,
              })}
              <ConvDot sessionId={answer.sessionId} />
            </span>
          )}
          {message !== undefined && (
            <span className={css.dLine}>
              {t('member.messageDigest', { text: message.text })}
              <ConvDot sessionId={message.sessionId} />
            </span>
          )}
        </div>
      </div>
      {open && (
        <div className={css.rows}>
          {section.rows.map((item, index) => (
            <ItemRow key={`${item.sessionId}:${String(item.seq ?? item.occurredAt)}:${String(index)}`}
              item={item} showConv reveal={reveal} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

const GROUPINGS: readonly ActivityGrouping[] = ['time', 'conversation', 'member']

/** Folded reading views of member messages and chosen answers for the shared project. */
export function ActivityBody(props: ActivityBodyProps): ReactNode {
  const { useStore, actions, refresh, loadMore, reveal, t } = props
  const items = useStore(state => state.items)
  const nextBefore = useStore(state => state.nextBefore)
  const loading = useStore(state => state.loading)
  const failed = useStore(state => state.failed)
  const grouping = useStore(state => state.grouping)
  const member = useStore(state => state.member)

  useEffect(() => { refresh() }, [refresh])

  const visible = useMemo(() => member === null ? items : items.filter(item => item.actorUserId === member), [items, member])
  const members = useMemo(() => feedMembers(items), [items])
  const sections = useMemo(
    () => groupItems(visible, grouping, () => t('row.untitledConversation')),
    [visible, grouping, t],
  )

  return (
    <div className={css.root}>
      <div className={css.toolbar}>
        <div className={css.segmented} role="group">
          {GROUPINGS.map(mode => (
            <button key={mode} type="button"
              className={mode === grouping ? css.segmentActive : css.segment}
              onClick={() => { actions.grouped(mode) }}>
              {t(`grouping.${mode}`)}
            </button>
          ))}
        </div>
        <select className={css.member} value={member === null ? '' : String(member)}
          aria-label={t('filter.allMembers')}
          onChange={(event) => { actions.filtered(event.target.value === '' ? null : Number(event.target.value)) }}>
          <option value="">{t('filter.allMembers')}</option>
          {members.map(entry => <option key={entry.userId} value={String(entry.userId)}>{entry.label}</option>)}
        </select>
        <button type="button" className={css.iconButton} title={t('toolbar.refresh')} aria-label={t('toolbar.refresh')}
          onClick={() => { refresh() }}>
          <IconRefreshOutline14 />
        </button>
      </div>
      <div className={css.feed}>
        {failed && <div className={css.notice}>{t('feed.failed')}</div>}
        {!failed && items.length === 0 && !loading && <div className={css.notice}>{t('feed.empty')}</div>}
        {grouping === 'time' && sections.map(section => (
          <DaySection key={section.id} section={section} reveal={reveal} t={t} />
        ))}
        {grouping === 'conversation' && sections.map(section => (
          <ConvBlock key={section.id} section={section} reveal={reveal} t={t} />
        ))}
        {grouping === 'member' && sections.map(section => (
          <MemberBlock key={section.id} section={section} reveal={reveal} t={t} />
        ))}
        {nextBefore !== undefined && !loading && (
          <button type="button" className={css.more} onClick={() => { loadMore(nextBefore) }}>{t('feed.loadMore')}</button>
        )}
        {loading && <div className={css.notice}>{t('feed.loading')}</div>}
      </div>
    </div>
  )
}
