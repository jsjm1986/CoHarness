/** Project activity panel: grouping toolbar over the L1 hairline feed list. */
import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { IconCheckOutline14, IconRefreshOutline14, IconRightUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityGrouping, ActivityItem } from './feed.ts'
import { feedMembers, groupItems, timeLabel } from './feed.ts'
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

function Row({ item, grouping, reveal, t }: {
  readonly item: ActivityItem
  readonly grouping: ActivityGrouping
  readonly reveal: ActivityInjected['reveal']
  readonly t: ActivityBodyProps['t']
}): ReactNode {
  const initial = item.actorLabel.trim().charAt(0).toUpperCase() || '?'
  return (
    <div className={css.row} role="button" tabIndex={0}
      title={t('row.reveal')}
      onClick={() => { reveal(item.sessionId, item.seq) }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') reveal(item.sessionId, item.seq) }}>
      <span className={css.time}>{timeLabel(item.occurredAt)}</span>
      <span className={css.avatar} aria-hidden>{initial}</span>
      <span className={css.body}>
        <span className={css.meta}>
          <span className={css.actor}>{item.actorLabel}</span>
          {grouping !== 'conversation' && (
            <button type="button" className={css.conversation} title={t('row.openConversation')}
              onClick={(event) => { event.stopPropagation(); reveal(item.sessionId, null) }}>
              {item.conversationTitle ?? t('row.untitledConversation')}
            </button>
          )}
          {item.kind === 'answer' && <span className={css.badge}>{t('row.answered')}</span>}
        </span>
        {item.kind === 'answer' && item.questionText !== undefined && (
          <span className={css.question}>「{item.questionText}」</span>
        )}
        {item.kind === 'answer'
          ? <span className={css.answer}><IconCheckOutline14 className={css.check} />{item.text}</span>
          : <span className={css.text}>{item.text}</span>}
      </span>
      <IconRightUpOutline14 className={css.jump} aria-hidden />
    </div>
  )
}

const GROUPINGS: readonly ActivityGrouping[] = ['time', 'conversation', 'member']

/** L1 hairline feed of member messages and chosen answers for the shared project. */
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

  let lastDay = ''
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
        {sections.map((section) => {
          const showDay = section.day !== undefined && section.day !== lastDay
          if (showDay) lastDay = section.day ?? ''
          return (
            <div key={section.id}>
              {showDay && <div className={css.day}>{section.day}</div>}
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{section.title}</span>
                {section.meta !== undefined && <span className={css.sectionMeta}>{section.meta}</span>}
              </div>
              {section.rows.map((item, index) => (
                <Row key={`${item.sessionId}:${item.seq ?? item.occurredAt}:${index}`} item={item}
                  grouping={grouping} reveal={reveal} t={t} />
              ))}
            </div>
          )
        })}
        {nextBefore !== undefined && !loading && (
          <button type="button" className={css.more} onClick={() => { loadMore(nextBefore) }}>{t('feed.loadMore')}</button>
        )}
        {loading && <div className={css.notice}>{t('feed.loading')}</div>}
      </div>
    </div>
  )
}
