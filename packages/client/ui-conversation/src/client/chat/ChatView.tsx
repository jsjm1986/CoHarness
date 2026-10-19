// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes, plus paging, pending steering and bottom-follow.
// Each row dispatches through 'conversation.chat.node'; ui-tool owns the
// tool-call renderer and its recursive root/subcall composition. A Host
// open-path refusal from the injected opener is an in-page dialog here.
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
//
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  ChatConversationViewNode, ConversationTimelineSnapshot, PendingSubmission, TurnNavigationItem,
} from '@deepseek-ai/dsh-client-runtime/client'
import { Button, CoHarnessMascot, IconChevronDownOutline14, MarkdownDelegateProvider, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileMediaUrl, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { ToolCallId } from '../contract/views.ts'
import type { ChatViewSlotProps, RenderMessageImages } from '../contract/slots.ts'
import type { ChatNode, TurnProcessChatData } from '../contract/chat-nodes.ts'
import { isAtOrOutside } from '../contract/group-tree.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { TurnNavigator } from './TurnNavigator.tsx'
import { formatRunDuration } from './message-chrome.ts'
import css from './ChatView.module.css'
import a11yCss from './accessibility.module.css'

const FOLLOW_THRESHOLD = 24
/** Start the next older-page request before the reader reaches the exact head. */
const OLDER_AUTO_LOAD_THRESHOLD = 240
/**
 * Reader-geometry sampling cadence. Locating the visible row hit-tests the
 * flow (forced layout), so a continuous reader scroll samples at most this
 * often, with one trailing sample so the final position is always recorded.
 */
const SCROLL_SAMPLE_INTERVAL_MS = 500
const EMPTY_PENDING_SUBMISSIONS: readonly PendingSubmission[] = []

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/**
 * Find an already-rendered settled row without interpolating a selector.
 * Saved and armed positions name exact rendered parts, while rail jumps name
 * the original Node — a split Node's rows carry part keys, so the Node key is
 * the fallback identity. Hidden rows have no box to align to and never match.
 */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  let nodePart: HTMLElement | null = null
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden]):not([hidden] *)')) {
    if (row.dataset.chatAnchorKey === key) return row
    if (nodePart === null && row.dataset.chatNodeKey === key) nodePart = row
  }
  return nodePart
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Visible rows eligible to carry a reader/paging position. Turn controls and
 * hidden rows are excluded: controls relocate when history expands their Turn,
 * and hidden rows have no box to align to. */
function anchorCandidates(list: HTMLElement): NodeListOf<HTMLElement> {
  return list.querySelectorAll<HTMLElement>(
    '[data-chat-anchor-key]:not([data-chat-group-key]):not([data-chat-flow-kind="turn-process"]):not(:empty):not([hidden]):not([hidden] *)',
  )
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  // Scroll events are hot: hit-test a few points through the stretched flow
  // rows before considering the mounted set. The fallback keeps jsdom and
  // pre-layout states deterministic at O(log n) box reads.
  if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
    const content = list.getBoundingClientRect()
    const left = Math.max(viewport.left, content.left)
    const right = Math.min(viewport.right, content.right)
    const x = left + Math.max(0, right - left) / 2
    const height = visibleBottom - viewport.top
    const points = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)]
    for (const offset of points) {
      for (const element of document.elementsFromPoint(x, viewport.top + offset)) {
        const row = element instanceof HTMLElement
          ? element.closest<HTMLElement>('[data-chat-anchor-key]')
          : null
        if (row === null || !list.contains(row) || row.dataset.chatFlowKind === 'turn-process') continue
        // An open group's header stays put while older members enter above
        // its body content: anchor inside the visible content instead.
        return row.dataset.chatGroupKey === undefined
          ? row
          : row.querySelector<HTMLElement>('[data-step-process-content] > [data-chat-anchor-key]:not(:empty):not([hidden]):not([hidden] *)') ?? row
      }
    }
  }
  const rows = anchorCandidates(list)
  // The reader's row is the first whose box crosses the scrollport top; flow
  // order matches box order, so a binary search finds it in O(log n) reads.
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows.item(middle).getBoundingClientRect().bottom > viewport.top) high = middle
    else low = middle + 1
  }
  const row = rows[low]
  return row !== undefined && row.getBoundingClientRect().top < visibleBottom ? row : rows[0] ?? null
}

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
}

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/** ProducedFiles opens the session workspace as `.`. */
function isFolderOpenPath(path: string): boolean {
  return path === '.'
}

function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

function nodeTurn(node: { readonly location: { readonly kind: string; readonly turn?: { readonly turn: number } } }): number | undefined {
  return node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn?.turn
    : undefined
}

/** Chat node kinds that never fold into a turn's collapsed process window. */
const TURN_PROCESS_INDEPENDENT: ReadonlySet<string> = new Set([
  'system-prompt', 'user', 'steering', 'turn-trigger', 'turn-process', 'turn-error', 'turn-max-tokens', 'turn-tail',
])

/**
 * Turns whose process window cannot collapse. Live, stopped, and failed Turns
 * keep their evidence open; a Turn holding an interleaved human input (one
 * anchored after its opening input, or any input when no opening input exists)
 * keeps it too — the transcript itself is part of the answer there.
 * Node locations carry the current lifecycle, so outcome reads stay correct
 * even when the timeline reference is stale.
 * @param order - visible Chat Node keys in presentation order.
 * @param nodes - resident Node reader.
 * @returns the always-open Turns plus those marked open by interleaved input.
 */
function alwaysOpenTurns(
  order: readonly string[],
  nodes: { get(key: string): ChatConversationViewNode | undefined },
): { readonly always: ReadonlySet<number>; readonly interleaved: ReadonlySet<number> } {
  const always = new Set<number>()
  const interleaved = new Set<number>()
  const controls = new Map<number, { readonly anchor: number; readonly startSeq: number | undefined }>()
  const inputs: { readonly turn: number; readonly anchor: number }[] = []
  for (const key of order) {
    const node = nodes.get(key) as ChatNode | undefined
    if (node === undefined) continue
    const location = node.location
    if (location.kind === 'turn' || location.kind === 'step') {
      const turn = location.turn
      const reason = (turn.end?.data as { readonly reason?: { readonly kind?: string } } | undefined)
        ?.reason?.kind
      if (turn.status === 'open' || reason === 'aborted' || reason === 'interrupted' || reason === 'error') {
        always.add(turn.turn)
      }
    }
    if (node.kind === 'turn-process') {
      const location = node.location
      controls.set(node.data.turn, {
        anchor: node.data.controlAnchorSeq,
        startSeq: location.kind === 'turn' || location.kind === 'step' ? location.turn.start?.seq : undefined,
      })
      continue
    }
    if (!isAtOrOutside(node, 'input')) continue
    const turn = nodeTurn(node)
    if (turn !== undefined) inputs.push({ turn, anchor: node.anchorSeq })
  }
  const openingAnchors = new Map<number, number>()
  for (const input of inputs) {
    const control = controls.get(input.turn)
    if (control !== undefined && (control.anchor === control.startSeq || input.anchor < control.anchor)) {
      openingAnchors.set(input.turn, Math.max(openingAnchors.get(input.turn) ?? input.anchor, input.anchor))
    }
  }
  for (const input of inputs) {
    const opening = openingAnchors.get(input.turn)
    if (controls.has(input.turn) && (opening === undefined || input.anchor > opening)) {
      interleaved.add(input.turn)
      always.add(input.turn)
    }
  }
  return { always, interleaved }
}

/** Return submission ids already represented by durable nodes, plus the last input's Turn. */
function observedInputs(
  order: readonly string[],
  nodes: { get(key: string): { readonly kind: string; readonly data: unknown; readonly location: ChatNode['location'] } | undefined },
): { readonly rpcIds: ReadonlySet<string>; readonly lastInputTurn: number | undefined } {
  const observed = new Set<string>()
  let lastInputTurn: number | undefined
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const turn = nodeTurn(node)
    if (turn !== undefined) lastInputTurn = turn
    const source = (node.data as { readonly source?: unknown }).source as
      | { readonly kind?: unknown; readonly rpcId?: unknown }
      | undefined
    if (source?.kind === 'user' && typeof source.rpcId === 'string') observed.add(source.rpcId)
  }
  return { rpcIds: observed, lastInputTurn }
}

/** Brand wordmark spelled out letter-by-letter so the status pulse can stagger it. */
const TURN_STATUS_WORD = 'COHARNESS'.split('')

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }: {
  /** The running turn's logged `turn/start` time; null falls back to mount
   *  time when that boundary is outside the window. */
  startTime: number | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      <span className={a11yCss.visuallyHidden}>{t('chat.deepDiving')}</span>
      <CoHarnessMascot size={20} busy />
      <span className={css.turnStatusWord} aria-hidden>
        {TURN_STATUS_WORD.map((letter, i) => (
          <span key={i} style={{ animationDelay: `${i * 0.09}s` }}>{letter}</span>
        ))}
      </span>
      <span className={css.turnStatusDots} aria-hidden><i /><i /><i /></span>
      {showClock && (
        <span className={css.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t).map(part => part.text).join('')}
        </span>
      )}
    </div>
  )
}

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useSessions, useStore, renderSlot, sessionId, openFile, openDetails, openExternalLink, loadOlder,
  loadHistoryUntil, loadImage, inspectCall, chatScroll, forkAt,
  fileMentions, presentation, t,
}: ChatViewSlotProps) {
  const order = useSession(s => s.chat.order)
  const entries = useSession(s => s.chat.entries)
  const nodeStore = useSession(s => s.chat.nodes)
  const timeline = useSession(s => s.chat.timeline)
  const navigation = useSession(s => s.chat.navigation)
  const historyNavigation = useSession(s => s.historyNavigation)
  const inbox = useSession(s => s.queue)
  const pendingSubmissions = useSession(s => s.pendingSubmissions ?? EMPTY_PENDING_SUBMISSIONS)
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const fileImages = useMemo(() => ({
    resolve: (path: string) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
    labels: {
      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),
      dialog: t('image.dialog'), close: t('image.close'),
    },
  }), [cwd, t])
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const historyWindowMode = useSession(s => s.historyWindowMode)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => s.selection?.callId)
  const presentationPolicy = useSyncExternalStore(
    listener => presentation.subscribe(listener),
    () => presentation.getSnapshot(),
  )
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string; options?: { line?: number } } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<{ sessionId: typeof sessionId; name: string } | null>(null)
  const activeSkill = selectedSkill?.sessionId === sessionId ? selectedSkill.name : undefined
  const openSkill = useCallback((name: string) => { setSelectedSkill({ sessionId, name }) }, [sessionId])
  const closeSkill = useCallback(() => { setSelectedSkill(null) }, [])
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [processOpen, setProcessOpen] = useState<ReadonlyMap<number, boolean>>(new Map())
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const openCallDetails = useCallback((callId: ToolCallId) => { openDetails({ callId }) }, [openDetails])
  const requestOpenFile = useCallback((path: string, options?: { line?: number }) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void (options === undefined ? openFile(path) : openFile(path, options)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          ...(options === undefined ? {} : { options }),
          message: openFailureMessage(
            error,
            t(isFolderOpenPath(path) ? 'fileOpen.folderUnknown' : 'fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const pendingSteering = useMemo(() => {
    // Admitted local identities outlive their bubbles until retirement, so a
    // stale steering row carrying the same rpcId must not reappear beside them.
    const localIds = new Set(
      pendingSubmissions.filter(submission => submission.placement !== 'queued')
        .map(submission => submission.requestId as string),
    )
    return inbox.filter(item =>
      item.placement === 'steering' && (item.rpcId === undefined || !localIds.has(item.rpcId)))
  }, [inbox, pendingSubmissions])
  // Keep the local echo hidden once its durable counterpart renders; the
  // echo→durable swap stays atomic regardless of when retirement lands.
  const [visibleSubmissions, lastInputTurn] = useMemo(() => {
    if (pendingSubmissions.length === 0) return [pendingSubmissions, undefined] as const
    const observed = observedInputs(order, nodeStore)
    return [
      pendingSubmissions.filter(item => item.placement !== 'queued' && !observed.rpcIds.has(item.requestId)),
      observed.lastInputTurn,
    ] as const
  }, [nodeStore, order, pendingSubmissions])
  const transcriptSubmissions = useMemo(
    () => visibleSubmissions.filter(item => item.placement !== 'queued' && item.placement !== 'steering'),
    [visibleSubmissions],
  )
  const steeringSubmissions = useMemo(
    () => visibleSubmissions.filter(item => item.placement === 'steering'),
    [visibleSubmissions],
  )
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )
  const runningTurnStart = useMemo(() => runningTurnStartTime(timeline), [timeline])
  // An empty opening control follows the first local transcript echo, never steering.
  const tailKey = order.at(-1)
  const tailNode = tailKey === undefined ? undefined : nodeStore.get(tailKey)
  const hoistFirstTranscript = running && tailNode?.kind === 'turn-process'
    && tailNode.location.kind === 'turn'
    && tailNode.location.turn.status === 'open'
    && tailNode.location.turn.turn !== lastInputTurn
  /**
   * Merge the full-session index with loaded anchors. Index-only markers keep
   * their durable range and become clickable after `loadHistoryUntil` brings
   * that range into the resident window. Loaded rows always win for previews
   * and anchor identity; live-only turns are retained until the next refresh.
   */
  // The builder replaces its items array only on an actual rebuild, so the
  // array identity below — not the stable index object — tracks loaded turns.
  const loaded = navigation.items()
  const navigationItems = useMemo(() => {
    // Keep the last successful index visible while a debounced refresh is in
    // flight; a transient network failure must not make the rail collapse.
    const indexed = historyNavigation?.items ?? []
    if (indexed.length === 0) return loaded
    const loadedByTurn = new Map(loaded.map(item => [item.turn, item]))
    const indexedByTurn = new Map(indexed.map(item => [item.turn, item]))
    const turns = [...new Set([...indexedByTurn.keys(), ...loadedByTurn.keys()])]
      .map(turn => ({ turn, marker: indexedByTurn.get(turn), loaded: loadedByTurn.get(turn) }))
      .sort((left, right) => {
        const leftSeq = left.marker?.startSeq ?? left.loaded?.startSeq ?? Number.MAX_SAFE_INTEGER
        const rightSeq = right.marker?.startSeq ?? right.loaded?.startSeq ?? Number.MAX_SAFE_INTEGER
        return leftSeq - rightSeq || left.turn - right.turn
      })
    return turns.map(({ turn, marker }) => {
      const current = loadedByTurn.get(turn)
      if (current !== undefined) {
        return marker === undefined
          ? current
          : {
            ...current,
            startSeq: marker.startSeq,
            endSeq: marker.endSeq,
            loaded: true,
          }
      }
      if (marker === undefined) return undefined
      return {
        turn: marker.turn,
        anchorKey: '',
        startSeq: marker.startSeq,
        endSeq: marker.endSeq,
        loaded: false,
        prompt: marker.prompt ?? '',
        response: marker.response ?? '',
      }
    }).filter((item): item is TurnNavigationItem => item !== undefined)
  }, [historyNavigation, loaded])

  const processByTurn = useMemo(() => {
    const result = new Map<number, TurnProcessChatData>()
    for (const key of order) {
      const node = nodeStore.get(key) as ChatNode | undefined
      if (node?.kind === 'turn-process') result.set(node.data.turn, node.data)
    }
    return result
  }, [nodeStore, order])
  /** Newest turn owning a process node; the next-input timing defers only it. */
  const latestTurn = useMemo(() => {
    let latest: number | undefined
    for (const turn of processByTurn.keys()) latest = latest === undefined ? turn : Math.max(latest, turn)
    return latest
  }, [processByTurn])
  // 'next-input' keeps the newest completed Turn's process open until another
  // input lands below it — a transcript-placed pending submission already is
  // that input's echo.
  const deferCollapse = presentationPolicy.collapseTiming === 'next-input'
    && !visibleSubmissions.some(item => item.placement === 'transcript')
  const openTurns = useMemo(() => alwaysOpenTurns(order, nodeStore), [nodeStore, order])
  /**
   * Keys of nodes folded behind a closed turn's process toggle. Folded nodes
   * stay mounted — a late-arriving reply or in-flight stream mutates while
   * hidden and must paint complete when the toggle opens.
   */
  const foldedKeys = useMemo(() => {
    const folded = new Set<string>()
    for (const key of order) {
      const node = nodeStore.get(key) as ChatNode | undefined
      if (node === undefined) continue
      const turn = nodeTurn(node)
      if (turn === undefined) continue
      const process = processByTurn.get(turn)
      if (process === undefined || node.kind === 'turn-process') continue
      const open = processOpen.get(turn)
        ?? (!presentationPolicy.foldCompletedTurns
          || (deferCollapse && turn === latestTurn) || openTurns.always.has(turn))
      if (open) continue
      if (TURN_PROCESS_INDEPENDENT.has(node.kind)) continue
      if (process.answerAnchorSeq !== null
        && node.kind === 'assistant-step' && node.data.finalNode?.seq === process.answerAnchorSeq) continue
      // A turn without an assistant answer folds everything after its first
      // evidence — that is where a late question reply lands.
      if (node.anchorSeq >= process.processStartSeq
        && (process.answerAnchorSeq === null || node.anchorSeq < process.answerAnchorSeq)) folded.add(key)
    }
    return folded
  }, [nodeStore, order, processByTurn, processOpen, openTurns, presentationPolicy, deferCollapse, latestTurn])

  /** Turns whose process window is currently folded — group containers hide with their members. */
  const foldedTurns = useMemo(() => {
    const turns = new Set<number>()
    for (const key of foldedKeys) {
      const node = nodeStore.get(key) as ChatNode | undefined
      const turn = node === undefined ? undefined : nodeTurn(node)
      if (turn !== undefined) turns.add(turn)
    }
    return turns
  }, [foldedKeys, nodeStore])

  /** Turns holding any foldable process evidence — a control over nothing stays a plain label. */
  const contentfulTurns = useMemo(() => {
    const counts = new Map<number, number>()
    for (const key of order) {
      const node = nodeStore.get(key) as ChatNode | undefined
      if (node === undefined) continue
      const turn = nodeTurn(node)
      if (turn === undefined) continue
      const process = processByTurn.get(turn)
      if (process === undefined || TURN_PROCESS_INDEPENDENT.has(node.kind)) continue
      if (node.anchorSeq < process.processStartSeq
        || (process.answerAnchorSeq !== null && node.anchorSeq >= process.answerAnchorSeq)) continue
      // The answering Step's own reasoning part joins the group without making
      // the process external; hasContent still counts spec.inlineReasoning.
      if (node.kind === 'assistant-step'
        && process.answerStep !== null && node.data.step === process.answerStep) continue
      counts.set(turn, (counts.get(turn) ?? 0) + 1)
    }
    return counts
  }, [nodeStore, order, processByTurn])

  const groupStore = useSession(s => s.chat.groups)
  /** Group key -> owning turn, read once per entries revision (a group's turn never changes). */
  const groupTurnOf = useMemo(() => {
    const map = new Map<string, number>()
    for (const entry of entries) {
      if (entry.kind !== 'group') continue
      const data = groupStore.get(entry.key)?.data
      if (typeof data === 'object' && data !== null && 'turn' in data && typeof data.turn === 'number') {
        map.set(entry.key, data.turn)
      }
    }
    return (key: string): number | undefined => map.get(key)
  }, [entries, groupStore])

  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Last position delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  /** Head identity already requested by the automatic top sentinel. */
  const autoLoadHeadRef = useRef<string | undefined>(undefined)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  const lastSteeringIdRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (which would snap inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)
  /** Invalidates a previous marker click while its range is being materialized. */
  const navigationRequestRef = useRef(0)

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastNode = lastKey === null ? undefined : nodeStore.get(lastKey)
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const lastSubmissionId = visibleSubmissions.at(-1)?.requestId ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}:${lastSubmissionId ?? ''}`

  const loadOlderAnchored = useCallback((): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging control and scroll listener run after mount. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
    }
    loadOlder()
  }, [loadOlder])

  /** Request one older page when the reader is near the head, with one request per head. */
  const maybeAutoLoadOlder = useCallback((el: HTMLElement): void => {
    if (el.scrollTop > OLDER_AUTO_LOAD_THRESHOLD) {
      autoLoadHeadRef.current = undefined
      return
    }
    if (el.scrollHeight <= 0 || openState !== 'open' || !hasMore || running
      || historyWindowMode !== 'tail' || loadingOlder) return
    const head = `${sessionId}:${firstSeq === null ? 'empty' : String(firstSeq)}:${String(order.length)}`
    if (autoLoadHeadRef.current === head) return
    autoLoadHeadRef.current = head
    loadOlderAnchored()
  }, [firstSeq, hasMore, historyWindowMode, loadOlderAnchored, loadingOlder, openState, order.length, running, sessionId])

  const toBottom = (el: HTMLElement): void => {
    anchorRef.current = null
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
  }

  useLayoutEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    // Automatic live-history expansion has no click handler to arm the
    // prepend anchor. Capture the reader's current row before its merged page
    // lands; a pinned reader intentionally keeps following the tail instead.
    if (loadingOlder && anchorRef.current === null && !atBottomRef.current) {
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
    }
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (openState === 'open' && !openedRef.current) {
      openedRef.current = true
      const saved = chatScroll.read()
      if (saved === null) {
        toBottom(el)
      } else {
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop
        observedTopRef.current = el.scrollTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
        const normalized = isAtBottom ? null : scrollPosition(local, el)
        if (isAtBottom) chatScroll.save(null)
        else if (normalized !== null) chatScroll.save(normalized)
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      const row = anchorElement(local, anchor.key)
      if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top
      observedTopRef.current = el.scrollTop
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === 'user'
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (appendedUser || appendedSteering || (tipMoved && atBottomRef.current)) toBottom(el)
  }, [
    chatScroll.read, chatScroll.save, firstSeq, followSig, lastKey,
    lastNode?.kind, lastSteeringId, loadingOlder, openState,
  ])

  // A short history can already be at the head after the initial bottom jump;
  // run the same guarded probe once after layout so it does not require a
  // synthetic scroll event from the browser.
  useEffect(() => {
    const local = listRef.current
    if (local !== null) maybeAutoLoadOlder(scrollerOf(local))
  }, [maybeAutoLoadOlder])

  /** Locate the reader's row once: the active rail turn, the pending prepend anchor, and the saved position. */
  const sampleReaderGeometryRef = useRef(() => {})
  sampleReaderGeometryRef.current = () => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const readerAnchor = pagingAnchor(local, el)
    const anchorKey = readerAnchor?.dataset.chatAnchorKey
    if (readerAnchor === null || anchorKey === undefined) return
    const readerNode = nodeStore.get(anchorKey)
    const readerTurn = readerNode === undefined ? undefined : nodeTurn(readerNode)
    if (readerTurn !== undefined) setActiveTurn(readerTurn)
    if (atBottomRef.current) return
    const position: ChatScrollPosition = { anchorKey, anchorTop: flowTop(readerAnchor, el), scrollTop: el.scrollTop }
    if (anchorRef.current !== null || loadingOlder) {
      anchorRef.current = { key: position.anchorKey, top: position.anchorTop }
    }
    // Continuous save (unmount happens after ref detach, so saving there is
    // too late); pinned-to-bottom clears so a remount keeps following.
    chatScroll.save(position)
  }
  const geometrySampleRef = useRef<{ at: number; timer: ReturnType<typeof setTimeout> | null }>({ at: 0, timer: null })
  /**
   * Sample now when the interval has elapsed or a prepend is pending (the
   * arriving page must preserve the reader's latest row, not a sampled one);
   * otherwise schedule the trailing sample.
   */
  const requestGeometrySample = (immediate: boolean): void => {
    const sample = geometrySampleRef.current
    const now = Date.now()
    const elapsed = now - sample.at
    if (immediate || elapsed >= SCROLL_SAMPLE_INTERVAL_MS) {
      sample.at = now
      sampleReaderGeometryRef.current()
      return
    }
    if (sample.timer !== null) return
    sample.timer = setTimeout(() => {
      sample.timer = null
      sample.at = Date.now()
      sampleReaderGeometryRef.current()
    }, SCROLL_SAMPLE_INTERVAL_MS - elapsed)
  }
  // A deferred sample still pending at unmount is the reader's newest
  // position (a tab or session switch inside the interval); flush it here.
  // Layout cleanup runs before React detaches the child ref and removes the
  // node, so the scrollport is still laid out — the passive cleanup is not.
  useLayoutEffect(() => () => {
    const sample = geometrySampleRef.current
    if (sample.timer === null) return
    clearTimeout(sample.timer)
    sample.timer = null
    sampleReaderGeometryRef.current()
  }, [])

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    maybeAutoLoadOlder(el)
    // Only reader input may make raw scroll geometry change follow ownership:
    // a delivered position that deviates from the observed-top ledger (every
    // programmatic write records itself there synchronously). This covers
    // wheel, touch, scrollbar, and keyboard alike without naming devices.
    // Browser shrink-clamps land exactly on the floor min and delayed
    // programmatic deliveries land on the ledger itself, so both preserve
    // the current ownership state.
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
    // Geometry decides at-bottom, not the ledger: browser writes (shrink
    // clamps, scroll anchoring) never reach observedTop, so inheriting a stale
    // `false` ref would strand a floor-landed reader unpinned with the
    // back-to-bottom button stuck on.
    const isAtBottom = floor - el.scrollTop <= FOLLOW_THRESHOLD + 1
    if (!movedByReader && isAtBottom) {
      // A follow write delivered its own scroll event (every stream publication
      // while pinned): the reader is at the tail, so the tail row names the
      // active turn and no hit-test is needed.
      const tailTurn = lastNode === undefined ? undefined : nodeTurn(lastNode)
      if (tailTurn !== undefined) setActiveTurn(tailTurn)
      if (!atBottomRef.current) {
        // Re-pinning from an un-ledgered write clears the stale saved position
        // the same way a reader scroll back to the bottom does.
        anchorRef.current = null
        chatScroll.save(null)
      }
      setAtBottom(true)
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    if (isAtBottom) {
      anchorRef.current = null
      chatScroll.save(null)
    }
    observedTopRef.current = el.scrollTop
    requestGeometrySample(anchorRef.current !== null || loadingOlder)
  }

  // Bind the scroll listener on the resolved scrollport once per mount;
  // reader-input attribution rides the observed-top ledger, not per-device
  // input listeners.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    const observer = new ResizeObserver(() => { followRef.current?.() })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => { observer.disconnect() }
  }, [])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  const navigateToTurn = useCallback((item: TurnNavigationItem): void => {
    const request = ++navigationRequestRef.current
    const jump = async (): Promise<void> => {
      setBusyTurn(item.turn)
      let target = item
      try {
        if ((target.loaded === false || target.anchorKey === '') && target.startSeq !== undefined) {
          if (loadHistoryUntil === undefined || !await loadHistoryUntil(target.startSeq)) return
          // Session publication is batched; wait one task for the corresponding
          // keyed row to commit before measuring its flow position.
          await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
          if (request !== navigationRequestRef.current) return
          target = navigation.items().find(candidate => candidate.turn === item.turn && candidate.anchorKey !== '') ?? target
        }
        if (request !== navigationRequestRef.current || target.anchorKey === '') return
        const local = listRef.current
        if (local === null) return
        const el = scrollerOf(local)
        const row = anchorElement(local, target.anchorKey)
        if (row === null) return
        el.scrollTop = Math.max(0, el.scrollTop + flowTop(row, el) - 24)
        observedTopRef.current = el.scrollTop
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        setAtBottom(atBottomRef.current)
        setActiveTurn(target.turn)
        const position = atBottomRef.current ? null : scrollPosition(local, el)
        chatScroll.save(position)
      } finally {
        if (request === navigationRequestRef.current) setBusyTurn(null)
      }
    }
    void jump()
  }, [chatScroll.save, loadHistoryUntil, navigation])

  return (
    <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={requestOpenFile} fileImages={fileImages}>
      <div className={css.root}>
        <div ref={listRef} className={css.scroll}>
          <TurnNavigator items={navigationItems} activeTurn={activeTurn} busyTurn={busyTurn} onNavigate={navigateToTurn} t={t} />
          <div ref={columnRef} className={css.column} data-chat-flow="">
            {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
            {openState === 'error' && openError !== null && (
              <div className={css.openError}>
                {t('chat.loadError', { message: openError.message, code: openError.code })}
              </div>
            )}
            {openState === 'open' && historyWindowMode === 'expanding' && (
              <div className={css.hint} data-history-expanding="" role="status" aria-live="polite">
                {t('chat.expandingHistory')}
              </div>
            )}
            {hasMore && !running && historyWindowMode === 'tail' && (
              <div className={css.older}>
                <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
                  {loadingOlder ? t('loading') : t('chat.loadOlder')}
                </button>
              </div>
            )}
            {entries.map((entry) => {
              if (entry.kind === 'group') {
                return (
                  <ChatGroupSeat
                    key={entry.key}
                    groupKey={entry.key}
                    turnFolded={foldedTurns.has(groupTurnOf(entry.key) ?? -1)}
                    foldedKeys={foldedKeys}
                    presentation={presentationPolicy}
                    deferCollapse={deferCollapse}
                    latestTurn={latestTurn}
                    useSession={useSession}
                    selectedCallId={selectedCallId}
                    cwd={cwd}
                    openFile={requestOpenFile}
                    openSkill={openSkill}
                    openCallDetails={openCallDetails}
                    inspectCall={inspectCall}
                    forkAt={forkAt}
                    renderMessageImages={renderMessageImages}
                    fileMentions={fileMentions}
                    renderSlot={renderSlot}
                    t={t}
                  />
                )
              }
              const nodeKey = entry.key
              const node = nodeStore.get(nodeKey) as ChatNode | undefined
              const turn = node === undefined ? undefined : nodeTurn(node)
              const process = turn === undefined ? undefined : processByTurn.get(turn)
              const open = turn === undefined || process === undefined
                ? true
                : processOpen.get(turn)
                  ?? (!presentationPolicy.foldCompletedTurns
                    || (deferCollapse && turn === latestTurn) || openTurns.always.has(turn))
              const folded = foldedKeys.has(nodeKey)
              const turnLocation = node !== undefined
                && (node.location.kind === 'turn' || node.location.kind === 'step')
                ? node.location.turn
                : undefined
              const turnProcess = node?.kind === 'turn-process' && turn !== undefined
                ? {
                  open,
                  setOpen: (value: boolean) => {
                    setProcessOpen((previous) => {
                      const next = new Map(previous)
                      next.set(turn, value)
                      return next
                    })
                  },
                  // The window exists once the Turn boundary is loaded; the
                  // toggle's outcome gate lives on `turnProcessAlwaysOpen`.
                  foldable: presentationPolicy.foldCompletedTurns
                    && (turnLocation?.start !== undefined || turnLocation?.status === 'closed'),
                  hasContent: !openTurns.interleaved.has(turn)
                    && ((contentfulTurns.get(turn) ?? 0) > 0 || process?.inlineReasoning === true),
                }
                : undefined
              return (
                <ChatNodeSeat
                  key={entry.groupPart === undefined ? nodeKey : `${nodeKey}:${entry.groupPart}`}
                  nodeKey={nodeKey}
                  folded={folded}
                  useSession={useSession}
                  selectedCallId={selectedCallId}
                  cwd={cwd}
                  openFile={requestOpenFile}
                  openSkill={openSkill}
                  openCallDetails={openCallDetails}
                  inspectCall={inspectCall}
                  forkAt={forkAt}
                  renderMessageImages={renderMessageImages}
                  fileMentions={fileMentions}
                  presentation={presentationPolicy}
                  {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }}
                  {...turnProcess === undefined ? {} : { turnProcess }}
                  renderSlot={renderSlot}
                  t={t}
                />
              )
            })}
            {/* No pending placeholders: questions (ui-user-questions) and approvals
                (ApprovalPanel) both take over the composer, so a flow card would
                double-render the same wait. */}
            {/* Turn-level loading signal: rides the whole running turn (first-token
                wait, tool execution, streaming) so it never flickers per step. */}
            {running && hoistFirstTranscript && transcriptSubmissions[0] !== undefined && (
              <PendingSubmissionBubble
                key={transcriptSubmissions[0].requestId}
                submission={transcriptSubmissions[0]}
                renderMessageImages={renderMessageImages}
                t={t}
              />
            )}
            {running && <TurnStatus startTime={runningTurnStart} t={t} />}
            {pendingSteering.map(item => (
              <PendingSteeringBubble
                key={item.id}
                content={item.content}
                renderMessageImages={renderMessageImages}
                t={t}
              />
            ))}
            {steeringSubmissions.map(submission => (
              <PendingSubmissionBubble
                key={submission.requestId}
                submission={submission}
                renderMessageImages={renderMessageImages}
                t={t}
              />
            ))}
            {transcriptSubmissions.slice(hoistFirstTranscript ? 1 : 0).map(submission => (
              <PendingSubmissionBubble
                key={submission.requestId}
                submission={submission}
                renderMessageImages={renderMessageImages}
                t={t}
              />
            ))}
          </div>
          {!atBottom && (
            <div className={css.toBottomSlot}>
              <button
                type="button"
                className={css.toBottom}
                aria-label={t('chat.toBottom')}
                onClick={() => {
                  const local = listRef.current
                  /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                  if (local !== null) toBottom(scrollerOf(local))
                }}
              >
                <IconChevronDownOutline14 />
              </button>
            </div>
          )}
        </div>
        {activeSkill !== undefined && renderSlot('conversation.chat.skill-preview', {
          skillName: activeSkill, onClose: closeSkill,
        }, {
          fallback: <Modal
            open
            title={`/${activeSkill}`}
            description={t('skillPreview.unavailable')}
            closeLabel={t('close')}
            onClose={closeSkill}
          />,
        })}
        {fileOpenError !== null && (
          <FileOpenErrorDialog
            path={fileOpenError.path}
            message={fileOpenError.message}
            busy={fileOpenBusy}
            onClose={closeFileOpenError}
            onRetry={() => { requestOpenFile(fileOpenError.path, fileOpenError.options) }}
            t={t}
          />
        )}
      </div>
    </MarkdownDelegateProvider>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  path, message, busy, onClose, onRetry, t,
}: {
  path: string
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t(isFolderOpenPath(path) ? 'fileOpen.folderTitle' : 'fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
