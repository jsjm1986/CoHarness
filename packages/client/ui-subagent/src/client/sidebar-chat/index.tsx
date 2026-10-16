/** Right-Sidebar presentation of an existing subagent Conversation. */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {
  InjectFace, PropsRenderFactories, PropsRenderSlots, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { useEffect, useState } from 'react'
import type { NS } from '../locales.ts'
import css from './SidebarChat.module.css'

/** Stable implementation identity for the Sidebar tab body. */
export const SUBAGENT_CHAT_ID = '@deepseek-ai/dsh-client-ui-subagent'

/** Resource-address prefix for an embedded Session chat. */
export const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/'

/** Parsed Sidebar chat resource address: the chat target and the Session hosting the tab. */
export interface SubagentChatTarget {
  readonly address: SubagentAddress
  /** Session whose right column hosts this tab; the resource owner for sidebar validation. */
  readonly hostSessionId: SessionId
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface SessionReferenceSourceMap {
    /** Sidebar chat occurrences holding their child Session open. */
    sidebarChat: true
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Session-scoped Conversation occurrence hosted by one Sidebar chat tab. */
    'sidebar.chat.conversation': { kind: 'single'; scope: 'session' }
  }
}

/**
 * Address one subagent Session together with the routing facts needed to restore it.
 * @param address - durable direct-parent subagent address.
 * @param hostSessionId - Session whose right column will host the chat tab.
 * @returns canonical Sidebar resource address.
 */
export function subagentChatAddress(address: SubagentAddress, hostSessionId: SessionId): string {
  const query = new URLSearchParams({
    parent: address.parentSessionId,
    mode: address.mode,
    host: hostSessionId,
  })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query}`
}

/**
 * Parse one canonical Sidebar chat resource address.
 * @param value - possible chat resource address.
 * @returns the encoded direct-parent address and host Session, or undefined for another or malformed resource.
 */
export function parseSubagentChatAddress(value: string): SubagentChatTarget | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_invalidUrl) {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'subagentchat') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  const parentSessionId = url.searchParams.get('parent')
  const mode = url.searchParams.get('mode')
  const hostSessionId = url.searchParams.get('host')
  if (
    parentSessionId === null || parentSessionId === ''
    || hostSessionId === null || hostSessionId === ''
    || (mode !== 'one-shot' && mode !== 'continuable')
  ) {
    return undefined
  }
  try {
    const childSessionId = decodeURIComponent(parts[1] as string)
    return {
      address: {
        parentSessionId: parentSessionId as SessionId,
        childSessionId: childSessionId as SessionId,
        mode,
      },
      hostSessionId: hostSessionId as SessionId,
    }
  } catch (_invalidEncoding) {
    return undefined
  }
}

/** Business callbacks supplied by the tab body registration. */
export interface SidebarChatTabInjected {
  /**
   * Load the addressed child's catalog and retain its Session until the tab
   * occurrence's signal aborts; resolves once the child scope exists.
   * @param contentId - the tab's `dsh-resource://subagentchat/` address.
   * @param signal - the tab occurrence lifetime.
   */
  pinSubagentChat: (contentId: string, signal: AbortSignal) => Promise<void>
}

/**
 * Hold the addressed child Session open for the pin signal's lifetime.
 * @param sessions - Sessions service.
 * @param contentId - canonical Sidebar chat resource address.
 * @param signal - the tab occurrence lifetime.
 */
async function pinSubagentChat(sessions: ISessions, contentId: string, signal: AbortSignal): Promise<void> {
  const target = parseSubagentChatAddress(contentId)
  if (target === undefined) return
  await sessions.refreshSubagents(target.address.parentSessionId)
  if (signal.aborted) return
  const reference = sessions.retain(target.address, { source: 'sidebarChat', signal })
  signal.addEventListener('abort', () => { reference.release() }, { once: true })
}

/** Fixed Chat selection used by an embedded Conversation occurrence. */
export function FixedChatConversationView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props supplied to the child-Session Conversation host. */
export type ConversationSlotPanelProps = PropsRuntime<'sidebar.chat.conversation'> & PropsRenderFactories

/** Render the shared Conversation content for one explicitly provided child Session. */
export function ConversationSlotPanel({ renderFactorySlot }: ConversationSlotPanelProps) {
  return renderFactorySlot('conversation.content', { variant: 'embedded' }, {
    slots: { views: FixedChatConversationView },
  })
}

/** Props supplied to the parent-Session Sidebar tab body. */
export type SidebarChatTabProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.chat.conversation'>
  & InjectFace<SidebarChatTabInjected>

/** Bind a chat address's child Session around its Conversation slot. */
export function SidebarChatTab({ useTabInfo, pinSubagentChat, SessionProvider, renderSlot }: SidebarChatTabProps) {
  const { tab } = useTabInfo()
  const [ready, setReady] = useState(false)
  const address = tab.navigation.address
  useEffect(() => {
    let live = true
    void pinSubagentChat(address, tab.signal).then(() => {
      if (live) setReady(true)
    })
    return () => { live = false }
  }, [address, tab.signal, pinSubagentChat])
  const child = ready ? parseSubagentChatAddress(address)?.address.childSessionId : undefined
  return (
    <div className={css.root} data-sidebar-chat="">
      {child === undefined
        ? null
        : (
          <SessionProvider sessionId={child}>
            {() => renderSlot('sidebar.chat.conversation', {})}
          </SessionProvider>
        )}
    </div>
  )
}

/**
 * Register the chat tab type and its right-Sidebar presentation.
 * @param ctx - Client root carrying Sessions, Slots, and Sidebar registries.
 * @param t - Subagent namespace translator used for fallback tab titles.
 */
export function registerSidebarChat(ctx: Context, t: TranslateNS<typeof NS>): void {
  const sessions = ctx.sessions
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SUBAGENT_CHAT_ID,
    kind: 'subagentchat',
    patterns: [`${SUBAGENT_CHAT_ADDRESS}**`],
    priority: 'builtin',
    canOpen: address => parseSubagentChatAddress(address) !== undefined,
    resourceSession: address => parseSubagentChatAddress(address)?.hostSessionId,
    title: (address) => {
      const child = parseSubagentChatAddress(address)?.address.childSessionId
      return child === undefined
        ? t('sidebar.chat')
        : sessions.list.getSnapshot().byId[child]?.projectionValues?.subagent?.label ?? child
    },
  } satisfies SidebarRightTabDefinition), 'ui-subagent: Sidebar chat type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SUBAGENT_CHAT_ID,
    children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
    inject: (): SidebarChatTabInjected => ({
      pinSubagentChat: (contentId: string, signal: AbortSignal) => pinSubagentChat(sessions, contentId, signal),
    }),
  }, SidebarChatTab)), 'ui-subagent: Sidebar chat body')
  ctx.effect(() => ctx.slots.inject('sidebar.chat.conversation', () => ctx.slots.register({
    name: 'sidebar.chat.conversation',
  }, ConversationSlotPanel)), 'ui-subagent: Sidebar Conversation')
}
