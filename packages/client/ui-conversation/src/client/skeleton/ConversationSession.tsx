/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import type { ViewTab } from '../contract/views.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

const DEFAULT_VIEW_ID = 'chat'

/** Resolve by id and keep stale persisted selections on the stable Chat fallback. */
function resolveActiveView(tabs: readonly ViewTab[], selectedId: string | null): ViewTab | undefined {
  const requestedId = selectedId ?? DEFAULT_VIEW_ID
  return tabs.find(view => view.id === requestedId)
    ?? tabs.find(view => view.id === DEFAULT_VIEW_ID)
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * The title's one state marker: an interaction waiting on the human is a
 * warning, work in flight is the animated matrix, and everything quieter
 * draws no dot at all — an idle session has nothing to announce.
 */
function sessionDotState(list: SessionListState, id: SessionId): StateDotState | undefined {
  const summary = list.byId[id]
  if (summary === undefined) return undefined
  if (summary.pendingInteraction !== undefined) return 'warning'
  if (summary.running) return 'ongoing'
  return undefined
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns the hidden blank-session header or visible title and tabs.
 */
export function ConversationSessionHeader({
  sessionId, useSession, useSessions, useStore, actions,
  renderSlot, views, open, t, compact = false, leading,
}: ConversationSessionHeaderProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const dotState = useSessions(s => sessionDotState(s, sessionId))
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const hideChrome = blank && composerPhase === 'blank'

  return (
    <header
      className={clsx(css.header, hideChrome && css.headerHidden)}
      aria-hidden={hideChrome || undefined}
    >
      {!hideChrome && (
        <>
          <div className={css.titleRow}>
            {leading}
            <div className={css.titleCluster}>
              {dotState === undefined ? null : (
                <span className={css.sessionDot} title={t(dotState === 'warning' ? 'session.status.waiting' : 'session.status.running')}>
                  <StateDot state={dotState} size={8} />
                  <span className={css.srOnly}>{t(dotState === 'warning' ? 'session.status.waiting' : 'session.status.running')}</span>
                </span>
              )}
              <nav
                className={css.crumbs}
                aria-label={t('session.hierarchy')}
                /* The strip scrolls horizontally on overflow; map the
                   vertical wheel onto it so a mouse wheel can reach the
                   clipped tail without a visible scrollbar. */
                onWheel={(e) => {
                  const el = e.currentTarget
                  if (el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY
                }}
              >
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  const title = (
                    <button
                      type="button"
                      className={clsx(css.crumb, last && css.crumbCurrent)}
                      disabled={last}
                      onClick={() => { open(summary.id) }}
                    >
                      {summary.displayTitle}
                    </button>
                  )
                  const lineageOwner = {
                    lineageSessionId: summary.id,
                    displayTitle: summary.displayTitle,
                    ...last ? {} : { openTitle: () => { open(summary.id) } },
                  }
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      {summary.subagent
                        ? renderSlot(
                          'conversation.session.header.lineage',
                          lineageOwner,
                          { fallback: title },
                        )
                        : (
                          <>
                            {title}
                            {renderSlot(
                              'conversation.session.header.lineage',
                              lineageOwner,
                              { fallback: null },
                            )}
                          </>
                        )}
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
              <div className={css.titleMeta}>
                {renderSlot('conversation.session.header.titleMeta', { compact })}
              </div>
            </div>
            {tabs.length > 1 && (
              <div
                className={css.tabs}
                role="tablist"
                /* Pill position without measuring JS: the bar divides into equal
                   columns and slides --dsh-tab-index to the active tab. */
                style={{
                  '--dsh-tab-count': tabs.length,
                  '--dsh-tab-index': Math.max(0, tabs.findIndex(t => t.id === active?.id)),
                } as CSSProperties}
              >
                {tabs.map(viewTab => (
                  <button
                    key={viewTab.id}
                    type="button"
                    role="tab"
                    aria-selected={viewTab.id === active?.id}
                    className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                    onClick={() => { actions.setView(viewTab.id) }}
                  >
                    {viewTab.label}
                  </button>
                ))}
              </div>
            )}
            <div className={css.headerActions}>
              {renderSlot('conversation.session.header.actions', { compact })}
            </div>
            <div className={css.headerUtilities}>
              {renderSlot('conversation.session.header.utilities', { compact })}
              {renderSlot('conversation.session.header.corner', {})}
            </div>
          </div>
        </>
      )}
    </header>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  sessionId, useSession, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, releaseSessionImages, compact = false,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  // `?? null`: persisted snapshots from before the inspect field rehydrate without it.
  const inspect = useStore(s => s.inspect ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  useEffect(() => () => {
    releaseSessionImages(sessionId)
  }, [releaseSessionImages, sessionId])

  if (blank && composerPhase === 'blank') return null
  return (
    <div className={css.viewArea}>
      {active !== undefined && renderSlot('conversation.view', {
        compact,
        inspect,
        onInspectDone: () => { actions.setInspect(null) },
      }, { only: active.id })}
    </div>
  )
}
