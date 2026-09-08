// Root conversation viewport and its resident Session pane. The pane keeps
// Hero/composer identity while the root owns explicit per-pane bindings.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import clsx from 'clsx'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationPaneSlotProps, ConversationSlotProps, InputZone,
} from '../contract/slots.ts'
import { HeroGlow, HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import { CHAT_CONTENT_WIDTH_RANGE } from '../../submission-settings.ts'
import css from './ConversationRoot.module.css'

function invokePointerCapture(target: HTMLElement, method: 'setPointerCapture' | 'releasePointerCapture', pointerId: number): void {
  const candidate: unknown = Reflect.get(target, method)
  if (typeof candidate === 'function') Reflect.apply(candidate, target, [pointerId])
}

/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps
export type ConversationPaneProps = ConversationPaneSlotProps

/** Render one Session's complete conversation surface. */
export function ConversationPane({
  sessionId, useSession, useSessions, useWorkspaces, useInput, useComposerBlock,
  useDisplaySettings, setDisplayWidth, renderSlot, renderSlotChain, selectWorkspace, newSession,
  t, compact = false, active = true, workbench = false, headerLeading,
}: ConversationPaneProps) {
  const openState = useSession(s => s.openState)
  const composerPhase = useSession(s => s.composerPhase)
  const pending = useSession(s => s.pending) ?? []
  const session = useSession(s => s)
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const workspaceName = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.workspaceName)
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  const summaryWorkspaceId = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.workspaceId)
  const workspaces = useWorkspaces(s => s)
  // A plugin this package cannot import (ui-model-selection) says this session cannot
  // send; its reason is already localized by whoever raised it.
  const composerBlock = useComposerBlock(block => block)
  const displaySettings = useDisplaySettings(value => value)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const widthPointer = useRef<{ id: number; width: number } | null>(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const [discardWorkspaceId, setDiscardWorkspaceId] = useState<WorkspaceId | undefined>()
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  // Publishes the seat's live height as --dsh-composer-height on the scroll
  // body so floating controls (ChatView back-to-bottom) clear the composer as
  // it grows. Callback ref, not an effect; stable identity prevents observer
  // churn while the first blank session fills the resident body outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
    })
    seatObserver.current.observe(seat)
  }, [])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const draftWorkspace = summaryBlank === true && summaryWorkspaceId !== undefined
    ? workspaces.items.find(workspace => workspace.workspaceId === summaryWorkspaceId)
    : undefined
  const activeWorkspace = sessionWorkspace ?? draftWorkspace
  const hintedWorkspaceId = summaryBlank === true && summaryWorkspaceId !== undefined
    && (activeWorkspace !== undefined || workspaces.phase !== 'ready')
    ? summaryWorkspaceId
    : undefined
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )
  const discardWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === discardWorkspaceId,
  )
  const hasUnsentDraft = inputState !== undefined && (
    inputState.draft !== ''
    || inputState.imageIds.length > 0
    || inputState.documentIds.length > 0
  )

  const navigateWorkspace = (workspaceId: WorkspaceId, discardDraft = false): void => {
    setPendingWorkspaceId(workspaceId)
    void selectWorkspace(workspaceId, { discardDraft }).catch(() => {
      setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
    })
  }

  const chooseWorkspace = (workspaceId: WorkspaceId): void => {
    setPickerOpen(false)
    if (pendingWorkspaceId !== undefined) return
    if (activeWorkspace?.workspaceId === workspaceId) return
    if (sessionId !== undefined && hasUnsentDraft) {
      setDiscardWorkspaceId(workspaceId)
      return
    }
    navigateWorkspace(workspaceId)
  }

  const confirmWorkspaceDiscard = (): void => {
    const workspaceId = discardWorkspaceId
    if (workspaceId === undefined) return
    setDiscardWorkspaceId(undefined)
    navigateWorkspace(workspaceId, true)
  }

  // Clear the pending pick once the session lands in it, or when the picked
  // workspace disappears from a ready list (deleted from the sidebar).
  useEffect(() => {
    if (pendingWorkspaceId !== undefined && (activeWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined))) {
      setPendingWorkspaceId(undefined)
    }
    if (discardWorkspaceId !== undefined && workspaces.phase === 'ready' && discardWorkspace === undefined) {
      setDiscardWorkspaceId(undefined)
    }
  }, [activeWorkspace?.workspaceId, discardWorkspace, discardWorkspaceId, pendingWorkspace, pendingWorkspaceId, workspaces.phase])

  // While a session is still replaying (loading + blank) the hero/docked
  // choice is unknowable — render the composer hidden instead of flashing
  // the centered hero and snapping to the docked bar (or vice versa).
  // Exemption: a session the list summary already proves blank can only
  // land on the hero, so hiding would blank the column for the whole
  // history round-trip (the startup auto-selection flash) for nothing.
  // The exemption is deliberately open-state-wide, not loading-only: a
  // summary-blank session is the hero before its open starts (`cold`) and
  // after one fails (`error`) for the same reason — there is no history.
  const settling = sessionId !== undefined && composerPhase === 'blank' && openState === 'loading'
    && summaryBlank !== true
  const hero = sessionId === undefined
    || (composerPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // The chip is a selector; label resolution walks the flow top-down:
  //   1. a just-picked workspace (pending) → its title;
  //   2. cold start, no session yet → placeholder ("Choose workspace");
  //   3. the blank session's attached or client-hinted workspace is in the list → its title;
  //   4. list still loading → cwd folder name bridges so the title does not
  //      flash on refresh (empty cwd → placeholder);
  //   5. list ready but no owning workspace (deleted from the sidebar) →
  //      placeholder, never the deleted folder's name via cwd.
  const chipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : activeWorkspace?.title
        ?? workspaceName
        ?? (workspaces.phase === 'ready' || cwd === undefined || cwd === ''
          ? undefined
          : workspaceLabel(cwd)))

  const newSessionWorkspaceId = pendingWorkspaceId
    ?? activeWorkspace?.workspaceId
    ?? hintedWorkspaceId
    ?? workspaces.recentWorkspaceId

  const heroWorkspaceRow = (
    <div className={css.heroWorkspaceRow}>
      {headerLeading}
      <WorkspaceChip
        buttonRef={pickerAnchor}
        label={chipTitle}
        menuOpen={pickerOpen}
        onClick={() => { setPickerOpen(open => !open) }}
        t={t}
      />
      {newSessionWorkspaceId !== undefined && (
        <button
          type="button"
          className={css.newSession}
          aria-label={t('hero.newSession')}
          onClick={() => { newSession(newSessionWorkspaceId) }}
        >
          <IconPlusOutline16 size={14} />
          <span>{t('hero.newSession')}</span>
        </button>
      )}
      {renderSlot('conversation.hero.workspace', {
        open: pickerOpen,
        anchorRef: pickerAnchor,
        selectedId: pendingWorkspaceId ?? activeWorkspace?.workspaceId ?? hintedWorkspaceId,
        onPick: chooseWorkspace,
        onClose: () => { setPickerOpen(false) },
      })}
      {renderSlot('conversation.hero.agentPreset', {})}
    </div>
  )

  // The placeholder chip ("Choose workspace") and the Workspace-trigger input travel
  // together: no workspace picked yet (cold start, no session at all), or a
  // blank session whose workspace vanished (deleted from the sidebar). The
  // bar is ONE session-maybe slot rendered unconditionally — inert is a prop,
  // not a different tree, so the textarea DOM survives the transition.
  const inert = sessionId === undefined || (hero && chipTitle === undefined)
  // A raised block is the same inert posture with the blocker's own reason:
  // one disabled textarea, never a second tree. The no-workspace state wins
  // when both hold — picking a workspace is the earlier prerequisite.
  const blocked = !inert && composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    variant: hero ? 'hero' : 'composer',
    active,
    compact,
    ...(inert
      ? {
        disabled: true,
        placeholder: t('placeholder.workspace'),
        workspacePickerOpen: pickerOpen,
        onRequestWorkspace: () => { setPickerOpen(true) },
      }
      : blocked
        // `blocked`, not `disabled`: the bar refuses input either way, but a
        // block keeps the model seat live because choosing a model is how the
        // user clears it.
        ? { blocked: composerBlock, placeholder: composerBlock.reason }
        : hero ? { placeholder: t('placeholder.hero') } : {}),
    overlay: renderSlot('conversation.input.overlay', {}),
    leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),
    rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
    // Stats band under the card, inside the bar's width column so both
    // share one constraint (composer.dock = stats-line family).
    footer: !hero && zone !== undefined ? renderSlot('conversation.composer.dock', zone) : null,
  })

  const composerBar = (
    <div className={clsx(css.composerStack, hero && css.composerHero)}>
      {hero && <HeroGlow className={css.heroGlow} />}
      {hero && <HeroShell t={t} renderSlot={renderSlot} />}
      {hero && heroWorkspaceRow}
      {zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {inputBar}
    </div>
  )

  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  const composer = renderSlotChain(
    'conversation.composer',
    { interactions: pending, session, active },
    { fallback: composerBar, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave Question/Approval panels at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      {composer}
    </div>
  )

  const widthStyle = {
    '--dsh-chat-content-width': `${displaySettings.chatContentWidth}px`,
    '--dsh-chat-font-size': `${displaySettings.chatFontSize}px`,
  } as CSSProperties
  const updateWidth = (clientX: number, startWidth?: number): void => {
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    const center = rect.left + rect.width / 2
    const origin = startWidth ?? displaySettings.chatContentWidth
    setDisplayWidth(origin + (clientX - (center + origin / 2)) * 2)
  }
  const beginWidthResize = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    invokePointerCapture(event.currentTarget, 'setPointerCapture', event.pointerId)
    widthPointer.current = { id: event.pointerId, width: displaySettings.chatContentWidth }
    updateWidth(event.clientX, displaySettings.chatContentWidth)
  }
  const moveWidthResize = (event: PointerEvent<HTMLDivElement>): void => {
    const active = widthPointer.current
    if (active?.id !== event.pointerId) return
    updateWidth(event.clientX, active.width)
  }
  const endWidthResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (widthPointer.current?.id !== event.pointerId) return
    widthPointer.current = null
    invokePointerCapture(event.currentTarget, 'releasePointerCapture', event.pointerId)
  }
  const onWidthKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 64 : 16
    const current = displaySettings.chatContentWidth
    const next = event.key === 'ArrowLeft' ? current - step
      : event.key === 'ArrowRight' ? current + step
        : event.key === 'Home' ? CHAT_CONTENT_WIDTH_RANGE.min
          : event.key === 'End' ? CHAT_CONTENT_WIDTH_RANGE.max
            : undefined
    if (next === undefined) return
    event.preventDefault()
    setDisplayWidth(next)
  }

  return (
    <div ref={rootRef} className={clsx(css.root, workbench && css.workbenchPane)} data-phase={phase} style={widthStyle}>
      {renderSlot('conversation.session.header', { compact, leading: hero ? undefined : headerLeading })}
      <div className={css.scrollBody} data-conversation-scroll="">
        <div
          className={css.widthHandle}
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={CHAT_CONTENT_WIDTH_RANGE.min}
          aria-valuemax={CHAT_CONTENT_WIDTH_RANGE.max}
          aria-valuenow={displaySettings.chatContentWidth}
          aria-label={t('settings.display.widthHandle')}
          tabIndex={0}
          data-conversation-width-handle=""
          onPointerDown={beginWidthResize}
          onPointerMove={moveWidthResize}
          onPointerUp={endWidthResize}
          onPointerCancel={endWidthResize}
          onKeyDown={onWidthKeyDown}
        />
        {renderSlot('conversation.session', { compact })}
        {composerSeat}
      </div>
      <Modal
        open={discardWorkspaceId !== undefined}
        onClose={() => { setDiscardWorkspaceId(undefined) }}
        title={t('workspace.discard.title')}
        description={t('workspace.discard.description', {
          name: discardWorkspace?.title ?? t('hero.chooseWorkspace'),
        })}
        closeLabel={t('workspace.discard.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDiscardWorkspaceId(undefined) }}>
              {t('workspace.discard.cancel')}
            </Button>
            <Button variant="primary" onClick={confirmWorkspaceDiscard}>
              {t('workspace.discard.confirm')}
            </Button>
          </>
        )}
      />
    </div>
  )
}

/** Render the current conversation or bounded explicit Session panes. */
export function ConversationRoot(props: ConversationRootProps) {
  const viewport = props.useStore(snapshot => snapshot)
  const available = props.useViewportAvailable(value => value)
  useEffect(() => {
    props.onViewportEnabled(available)
    return () => { props.onViewportEnabled(false) }
  }, [available, props.onViewportEnabled])
  const [maximizedId, setMaximizedId] = useState<SessionId | undefined>()
  const [width, setWidth] = useState<number | undefined>()
  const root = useRef<HTMLDivElement | null>(null)
  const workbench = available && viewport.mode === 'workbench'
  useEffect(() => {
    const node = root.current
    if (node === null) return
    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const next = node.getBoundingClientRect().width
        if (next > 0) setWidth(next)
      })
    })
    observer.observe(node)
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [workbench])
  const drag = useRef<{ pointerId: number; index: number; x: number; width: number; total: number; ratios: number[] } | null>(null)
  const compact = props.compact ?? false
  const tabbed = compact || (width !== undefined && width < 728)
  const activePane = viewport.activePaneId ?? viewport.paneIds[0]
  const maximized = maximizedId !== undefined && viewport.paneIds.includes(maximizedId) ? maximizedId : undefined
  // A selected tab always wins over a desktop-only maximization preference.
  const focusedPane = tabbed ? activePane : maximized ?? activePane
  const paneIds = (tabbed || maximized !== undefined) && focusedPane !== undefined ? [focusedPane] : viewport.paneIds
  const columns = tabbed || maximized !== undefined ? 1
    : width === undefined || width >= viewport.paneIds.length * 364 ? Math.max(1, paneIds.length) : 2
  const rows = Array.from({ length: Math.ceil(paneIds.length / columns) }, (_, row) => paneIds.slice(row * columns, (row + 1) * columns))
  const resize = (index: number, ratios: readonly number[], delta: number, rowWidth: number, rowTotal: number): void => {
    const next = [...ratios]
    const left = next[index] ?? 0
    const right = next[index + 1] ?? 0
    const total = left + right
    const minimum = Math.min(360 / Math.max(1, rowWidth) * rowTotal, total / 2)
    next[index] = Math.max(minimum, Math.min(total - minimum, left + delta))
    next[index + 1] = total - next[index]
    props.onViewportRatios(next)
  }
  if (!workbench) return available ? (
    <div className={css.workbenchRoot}>
      {props.renderSlot('conversation.pane', { compact, workbench: false, headerLeading: props.renderSlot('conversation.workbench.toolbar', { viewport, tabbed: false, inline: true }) })}
    </div>
  ) : props.renderSlot('conversation.pane', { compact })
  return (
    <div ref={root} className={css.workbenchRoot} data-workbench="" data-tabbed={tabbed || undefined} data-maximized={maximized !== undefined || undefined}>
      {props.renderSlot('conversation.workbench.toolbar', { viewport, tabbed })}
      {paneIds.length === 0 ? props.renderSlot('conversation.workbench.empty', {}) : (
        <div className={css.workbenchGrid} data-workbench-grid="">
          {rows.map((row, rowIndex) => {
            const ratioStart = rowIndex * columns
            const ratios = row.map((_, index) => viewport.paneRatios[ratioStart + index] ?? 1)
            const total = ratios.reduce((sum, ratio) => sum + ratio, 0)
            return (
              <div key={rowIndex} className={css.workbenchRow} data-workbench-row="" style={{ gridTemplateColumns: ratios.map(ratio => `minmax(${row.length > 1 ? 360 : 0}px, ${ratio}fr)`).join(' ') }}>
                {row.map((id, column) => {
                  const index = ratioStart + column
                  return (
                    <section
                      key={id}
                      className={css.workbenchPane}
                      data-session-pane={id}
                      data-active={id === activePane || undefined}
                      onPointerDown={() => { props.onViewportFocus(id) }}
                      onFocusCapture={() => { props.onViewportFocus(id) }}
                    >
                      <props.SessionProvider sessionId={id}>
                        {() => (
                          <>
                            {props.renderSlot('conversation.workbench.pane.header', {
                              active: id === activePane,
                              onFocus: () => { props.onViewportFocus(id) },
                              onClose: () => { if (maximized === id) setMaximizedId(undefined); props.onViewportRemove(id) },
                              maximized: maximized === id,
                              onMaximize: () => {
                                props.onViewportFocus(id)
                                const next = maximized !== id
                                props.onViewportMaximize(id, next)
                                setMaximizedId(current => current === id ? undefined : id)
                              },
                            })}
                            {props.renderSlot('conversation.pane', { compact: compact || viewport.paneIds.length > 1, active: id === activePane, workbench: true })}
                          </>
                        )}
                      </props.SessionProvider>
                      {column < row.length - 1 && (
                        <div
                          className={css.paneSeparator}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={props.t('viewport.resize')}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round((ratios[column] ?? 1) / total * 100)}
                          tabIndex={0}
                          onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            invokePointerCapture(event.currentTarget, 'setPointerCapture', event.pointerId)
                            drag.current = {
                              pointerId: event.pointerId, index, x: event.clientX,
                              width: event.currentTarget.parentElement?.parentElement?.clientWidth ?? 1,
                              total, ratios: [...viewport.paneRatios],
                            }
                          }}
                          onPointerMove={(event) => {
                            const current = drag.current
                            if (current === null || current.pointerId !== event.pointerId) return
                            resize(current.index, current.ratios,
                              (event.clientX - current.x) / current.width * current.total, current.width, current.total)
                          }}
                          onPointerUp={(event) => {
                            drag.current = null
                            invokePointerCapture(event.currentTarget, 'releasePointerCapture', event.pointerId)
                          }}
                          onPointerCancel={() => { drag.current = null }}
                          onKeyDown={(event) => {
                            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                            event.preventDefault()
                            resize(index, viewport.paneRatios, (event.key === 'ArrowLeft' ? -0.025 : 0.025) * total, event.currentTarget.parentElement?.parentElement?.clientWidth ?? 1, total)
                          }}
                        />
                      )}
                    </section>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
