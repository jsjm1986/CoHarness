// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
  type ConversationSnapshot, type ISessions, type SessionBinding, type SessionId,
  type SessionListState, type SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { Shortcuts, ShortcutContext, ShortcutGesture } from '@deepseek-ai/dsh-client-shortcuts/client'
import { installStopShortcut } from '../src/client/stop-shortcut.ts'

const SID = 's1' as SessionId

function snapshotOf(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), openTurn: undefined, partial: null, runningCalls: [],
    pending: [], queue: [], running: true, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false, historyWindowMode: 'tail', historyDetail: 'full',
    promptError: null, blank: false, subagent: null, lastAgentError: null,
    ...overrides,
  }
}

const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: SID, displayTitle: 's1', running: true, blank: false, updatedAt: 1, ...overrides,
})

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  document.body.replaceChildren()
})

function bench() {
  const session = createSnapshotStore<ConversationSnapshot>(snapshotOf({ openTurn: 1 }))
  const list = createSnapshotStore<SessionListState>({
    ids: [SID], byId: { [SID]: summary() }, archivedById: {}, current: SID, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, observedJobs: {}, currentAddress: undefined,
  })
  const binding = { sessionId: SID, session } as unknown as SessionBinding
  const bindings = new Map<SessionId, SessionBinding>([[SID, binding]])
  const sessions = {
    binding: (id: SessionId) => bindings.get(id),
    list,
  } as unknown as ISessions
  let listener: Parameters<Shortcuts['observeFixedInput']>[0] | undefined
  const shortcuts = {
    stopSequenceMs: 500,
    observeFixedInput: (callback: NonNullable<typeof listener>) => {
      listener = callback
      return () => { listener = undefined }
    },
  } as Shortcuts
  const cancel = vi.fn()
  const dispose = installStopShortcut(shortcuts, sessions, cancel)
  disposers.push(dispose)
  const root = document.createElement('div')
  root.dataset.conversationSession = 's1'
  root.dataset.conversationRegion = 'chat'
  document.body.append(root)
  const input = document.createElement('textarea')
  input.dataset.conversationRegion = 'composer'
  root.append(input)
  input.focus()
  const press = (overrides: Partial<ShortcutGesture> = {}, target: Element = input,
    context: Partial<ShortcutContext> = {}) => {
    const consume = vi.fn()
    listener?.({ type: 'keydown', gesture: { code: 'Escape', control: false, alt: false, shift: false,
      meta: false, repeat: false, composing: false, defaultPrevented: false, ...overrides },
    context: { region: 'editable', modal: null, target, ...context }, consume })
    return consume
  }
  return { cancel, input, root, press, dispose, session, list, bindings,
    reset: () => listener?.({ type: 'reset' }) }
}

describe('fixed stop routing', () => {
  it('cancels through the scoped conversation only after two eligible Escapes', () => {
    const b = bench()
    expect(b.press()).toHaveBeenCalledOnce()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.cancel).toHaveBeenCalledWith(SID)
  })

  it.each(['repeat', 'composing', 'defaultPrevented', 'control', 'alt', 'shift', 'meta'] as const)(
    'clears the sequence when %s owns a key', (field) => {
      const b = bench()
      b.press()
      expect(b.press({ [field]: true })).not.toHaveBeenCalled()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.press()
      expect(b.cancel).toHaveBeenCalledOnce()
    },
  )

  it('clears on other keys, local consumption, modal ownership and leaving Conversation', () => {
    const b = bench()
    for (const invalidate of [
      () => b.press({ code: 'KeyA' }), () => b.reset(),
      () => b.press({}, b.input, { modal: 'settings' }),
      () => b.press({}, document.body),
      () => b.press({}, b.input, { region: 'terminal' }),
    ]) {
      b.press()
      invalidate()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.reset()
    }
  })

  it('never combines a press with the next turn while running stays true', () => {
    const b = bench()
    b.press()
    b.session.set(snapshotOf({ running: true, openTurn: 2 }))
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('clears when a pending interaction appears and disappears between presses', () => {
    const b = bench()
    const setPending = (status?: SessionSummary['pendingInteraction']): void => {
      const state = b.list.getSnapshot()
      const row = { ...summary(), ...(status === undefined ? {} : { pendingInteraction: status }) }
      b.list.set({ ...state, byId: { ...state.byId, [SID]: row } })
    }
    b.press()
    setPending('approval')
    expect(b.press()).not.toHaveBeenCalled()
    setPending(undefined)
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('excludes terminal, iframe, approval and inert descendants even inside Conversation', () => {
    const b = bench()
    for (const [tag, attribute] of [['div', 'class'], ['iframe', ''], ['div', 'data-approval-key'], ['div', 'inert']]) {
      const element = document.createElement(tag!)
      if (attribute !== '') element.setAttribute(attribute!, attribute === 'class' ? 'xterm' : '')
      b.root.append(element)
      b.press()
      expect(b.press({}, element)).not.toHaveBeenCalled()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.reset()
    }
  })

  it('clears on running and removed lifecycle changes', () => {
    const b = bench()
    b.press()
    b.session.set(snapshotOf({ running: false, openTurn: 1 }))
    expect(b.press()).not.toHaveBeenCalled()
    b.session.set(snapshotOf({ running: true, openTurn: 1 }))
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.session.set(snapshotOf({ running: true, openTurn: 1, removed: true }))
    expect(b.press()).not.toHaveBeenCalled()
  })

  it('requires a live binding and observed turn start before arming', () => {
    const b = bench()
    b.root.dataset.conversationSession = 'missing'
    expect(b.press()).not.toHaveBeenCalled()
    b.root.dataset.conversationSession = 's1'
    b.session.set(snapshotOf({ running: true, openTurn: undefined }))
    expect(b.press()).not.toHaveBeenCalled()
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('clears the pending press when the Session binding is replaced', () => {
    const b = bench()
    b.press()
    const next = { sessionId: SID, session: b.session } as unknown as SessionBinding
    b.bindings.set(SID, next)
    b.session.set(snapshotOf({ running: true, openTurn: 1 }))
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('uses the existing stop path for continuable children and excludes one-shot children', () => {
    const b = bench()
    b.session.set(snapshotOf({ running: true, openTurn: 1,
      subagent: { parentAvailable: true, address: { parentSessionId: 'parent' as SessionId,
        childSessionId: SID, mode: 'one-shot' } } }))
    expect(b.press()).not.toHaveBeenCalled()
    b.session.set(snapshotOf({ running: true, openTurn: 1,
      subagent: { parentAvailable: false, address: { parentSessionId: 'parent' as SessionId,
        childSessionId: SID, mode: 'continuable' } } }))
    b.press()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('does not arm without a cancellable live turn or after disposal', () => {
    const b = bench()
    b.session.set(snapshotOf({ running: false }))
    expect(b.press()).not.toHaveBeenCalled()
    b.session.set(snapshotOf({ running: true, openTurn: 1 }))
    b.press()
    b.dispose()
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
  })
})
