// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionId, SessionListState, SessionReference, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {
  ConversationSlotPanel, FixedChatConversationView, parseSubagentChatAddress,
  registerSidebarChat, SidebarChatTab, subagentChatAddress, SUBAGENT_CHAT_ID,
  type SidebarChatTabInjected, type SidebarChatTabProps,
} from '../src/client/sidebar-chat/index.tsx'

const PARENT = 'parent/a' as SessionId
const HOST = 'host/1' as SessionId
const CHILD = 'child#1' as SessionId
const ADDRESS: SubagentAddress = {
  parentSessionId: PARENT,
  childSessionId: CHILD,
  mode: 'continuable',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Sidebar chat address', () => {
  it('round-trips the child identity, host, and direct-parent routing metadata', () => {
    const resource = subagentChatAddress(ADDRESS, HOST)
    expect(resource).toBe(
      'dsh-resource://subagentchat/session/child%231?parent=parent%2Fa&mode=continuable&host=host%2F1',
    )
    expect(parseSubagentChatAddress(resource)).toEqual({ address: ADDRESS, hostSessionId: HOST })
    expect(parseSubagentChatAddress(subagentChatAddress({ ...ADDRESS, mode: 'one-shot' }, HOST)))
      .toEqual({ address: { ...ADDRESS, mode: 'one-shot' }, hostSessionId: HOST })
  })

  it.each([
    'not an address',
    'https://chat/session/child?parent=parent&mode=continuable&host=host',
    'dsh-resource://other/session/child?parent=parent&mode=continuable&host=host',
    'dsh-resource://subagentchat/other/child?parent=parent&mode=continuable&host=host',
    'dsh-resource://subagentchat/session/child?mode=continuable&host=host',
    'dsh-resource://subagentchat/session/child?parent=&mode=continuable&host=host',
    'dsh-resource://subagentchat/session/child?parent=parent&mode=unknown&host=host',
    'dsh-resource://subagentchat/session/child?parent=parent&mode=continuable',
    'dsh-resource://subagentchat/session/child?parent=parent&mode=continuable&host=',
    'dsh-resource://subagentchat/session/%?parent=parent&mode=continuable&host=host',
  ])('rejects %s', (address) => {
    expect(parseSubagentChatAddress(address)).toBeUndefined()
  })
})

describe('Sidebar chat registration', () => {
  function makeContext() {
    const release = vi.fn()
    const reference = {
      sessionId: CHILD,
      ready: Promise.resolve(undefined),
      release,
      [Symbol.dispose]: release,
    } as unknown as SessionReference
    const retain = vi.fn(() => reference)
    const refreshSubagents = vi.fn(() => Promise.resolve())
    const list = {
      getSnapshot: () => ({
        ids: [],
        byId: {
          [CHILD]: {
            displayTitle: 'Projected title',
            projectionValues: { subagent: { mode: 'continuable', label: 'Worker', seq: 1 } },
          },
        },
        phase: 'ready',
        subagentsByParent: {},
        jobsBySession: {},
      } as unknown as SessionListState),
      subscribe: () => () => {},
    }
    let definition: SidebarRightTabDefinition | undefined
    const registrations: { options: Record<string, unknown>; component: unknown }[] = []
    const ctx = {
      sessions: { retain, refreshSubagents, list } as unknown as ISessions,
      sidebarRightTabs: { register: (value: SidebarRightTabDefinition) => { definition = value; return () => {} } },
      slots: {
        inject: (_name: string, install: () => () => void) => install(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      effect: (install: () => unknown) => { install(); return () => {} },
    } as unknown as Context
    return { ctx, definition: () => definition, registrations, retain, refreshSubagents, release }
  }

  it('registers the tab type, body, and child Conversation slot', () => {
    const { ctx, definition, registrations } = makeContext()
    registerSidebarChat(ctx, (key: string) => key === 'sidebar.chat' ? 'Chat' : key)

    const def = definition()
    expect(def?.id).toBe(SUBAGENT_CHAT_ID)
    expect(def?.kind).toBe('subagentchat')
    expect(def?.canOpen?.(subagentChatAddress(ADDRESS, HOST))).toBe(true)
    expect(def?.canOpen?.('dsh-resource://subagentchat/invalid')).toBe(false)
    expect(def?.resourceSession?.(subagentChatAddress(ADDRESS, HOST))).toBe(HOST)
    expect(def?.title(subagentChatAddress(ADDRESS, HOST))).toBe('Worker')
    expect(def?.title(subagentChatAddress({ ...ADDRESS, childSessionId: 'unknown' as SessionId }, HOST))).toBe('unknown')
    expect(def?.title('invalid')).toBe('Chat')
    expect(registrations.map(entry => entry.options.name)).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.chat.conversation',
    ])
    expect((registrations[0]?.options.children as Record<string, unknown>)['sidebar.chat.conversation'])
      .toEqual({ kind: 'single', scope: 'session' })
  })

  it('pins the child Session for the tab signal lifetime', async () => {
    const { ctx, registrations, retain, refreshSubagents, release } = makeContext()
    registerSidebarChat(ctx, (key: string) => key)
    const inject = registrations[0]?.options.inject as () => SidebarChatTabInjected
    const face = inject()

    const controller = new AbortController()
    await face.pinSubagentChat(subagentChatAddress(ADDRESS, HOST), controller.signal)
    expect(refreshSubagents).toHaveBeenCalledWith(PARENT)
    expect(retain).toHaveBeenCalledWith(ADDRESS, { source: 'sidebarChat', signal: controller.signal })
    controller.abort()
    expect(release).toHaveBeenCalledOnce()

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await face.pinSubagentChat(subagentChatAddress(ADDRESS, HOST), alreadyAborted.signal)
    expect(refreshSubagents).toHaveBeenCalledTimes(2)
    expect(retain).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)

    await face.pinSubagentChat('dsh-resource://other/x', new AbortController().signal)
    expect(retain).toHaveBeenCalledTimes(1)
  })

  it('does not retain when the tab closes during catalog refresh', async () => {
    const { ctx, registrations, retain, refreshSubagents } = makeContext()
    registerSidebarChat(ctx, (key: string) => key)
    const inject = registrations[0]?.options.inject as () => SidebarChatTabInjected
    const face = inject()

    let finishRefresh: (() => void) | undefined
    refreshSubagents.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRefresh = resolve }))
    const controller = new AbortController()
    const pending = face.pinSubagentChat(subagentChatAddress(ADDRESS, HOST), controller.signal)
    await vi.waitFor(() => { expect(finishRefresh).toBeTypeOf('function') })
    controller.abort()
    finishRefresh?.()
    await pending
    expect(retain).not.toHaveBeenCalled()
  })
})

describe('Sidebar chat components', () => {
  it('binds the pinned child Session around the Conversation slot', async () => {
    const signal = new AbortController().signal
    const address = subagentChatAddress(ADDRESS, HOST)
    const pinSubagentChat = vi.fn(() => Promise.resolve())
    const SessionProvider = vi.fn(({ children }: { sessionId?: string; children: (id: string) => ReactNode }) => (
      <>{children(CHILD)}</>
    ))
    const renderSlot = vi.fn(() => <span>child conversation</span>)
    const props = {
      useTabInfo: () => ({ tab: { navigation: { address }, signal } }),
      pinSubagentChat,
      SessionProvider,
      renderSlot,
    } as unknown as SidebarChatTabProps
    const view = render(<SidebarChatTab {...props} />)
    expect(view.container.textContent).toBe('')
    expect(pinSubagentChat).toHaveBeenCalledWith(address, signal)

    await waitFor(() => { expect(view.getByText('child conversation')).toBeTruthy() })
    expect(SessionProvider.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ sessionId: CHILD }))
    expect(renderSlot).toHaveBeenCalledWith('sidebar.chat.conversation', {})
  })

  it('renders the shared Conversation content embedded with the fixed local view', () => {
    const renderFactorySlot = vi.fn(() => null)
    render(<ConversationSlotPanel {...({ renderFactorySlot } as unknown as Parameters<typeof ConversationSlotPanel>[0])} />)
    expect(renderFactorySlot).toHaveBeenCalledWith(
      'conversation.content',
      { variant: 'embedded' },
      { slots: { views: FixedChatConversationView } },
    )
  })

  it('routes the fixed local view through the ordinary Conversation Session slot', () => {
    const renderSlot = vi.fn(() => null)
    render(<FixedChatConversationView {...({ renderSlot } as unknown as ConversationViewsProps)} />)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session', { view: 'chat' })
  })
})
