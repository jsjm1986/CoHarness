/** Session-scoped Sidebar tab backed by the existing Chat and Session-log models. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionBinding } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatNodeModel } from './chat-node/model.ts'
import { SessionLogModel } from './session-log/model.ts'
import { sessionLogChatTarget } from './session-log/chat-target.ts'
import { SessionInspectorView, type SessionInspectorInjected } from './View.tsx'
import { NS } from '../locales.ts'
import { mainChatRoot } from './chat-node/dom.ts'
import { resolveChatRevealTargets } from './chat-node/reveal-target.ts'
import { InspectorChatPicker } from './chat-node/picker.ts'

/**
 * Register the Session Inspector Sidebar page and its Session-scoped sources.
 * @param ctx - Client plugin context owning the tab registration and Session-bound model cache.
 */
export function registerInspectorTab(ctx: Context): void {
  let activePicker: InspectorChatPicker | undefined
  let disposed = false
  ctx.effect(() => () => { disposed = true; activePicker?.dispose() }, 'session-inspector: chat picker')
  const t = ctx.locale.bind(NS)
  const id = '@deepseek-ai/dsh-experimental-session-inspector'
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'session-inspector-log', title: () => t('tab.title'),
    guide: [{ id: 'open', order: 60, title: () => t('tab.title'), description: () => t('tab.description') }],
  }), 'session-inspector: sidebar tab')
  const models = new WeakMap<SessionBinding, SessionInspectorInjected>()
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: id, locale: NS,
    inject: (sessionId: SessionId): SessionInspectorInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`session-inspector: unknown Session ${sessionId}`)
      let sources = models.get(binding)
      if (sources === undefined) {
        const session = binding.session
        const chat = new ChatNodeModel(session)
        const log = new SessionLogModel(binding.eventSource)
        const chatRoot = () => ctx.sessions.list.getSnapshot().current === sessionId ? mainChatRoot() : undefined
        sources = { hooks: { chatRows: chat, logRows: log }, keyedHooks: { chatRecord: chat.row, logRecord: log.row },
          chatRoot, pickChat: (owner, picked, cancelled) => {
            if (disposed) return undefined
            activePicker?.cancel()
            const picker = new InspectorChatPicker(chatRoot, owner, picked, cancelled, () => {
              if (activePicker === picker) activePicker = undefined
            })
            if (!picker.start()) return undefined
            activePicker = picker
            return () => { picker.dispose() }
          },
          resolveChatTargets: target => resolveChatRevealTargets(target, session.getSnapshot().chat.nodes.values()),
          recordType: (key, mode) => (mode === 'chat-node' ? chat.row(key) : log.row(key))?.getSnapshot()?.type,
          loadOlder: () => binding.session.loadOlder(), objects: chat.objects(sessionId), logChatTarget: (key) => {
            const anchor = log.chatAnchor(key)
            if (anchor === undefined) return undefined
            return sessionLogChatTarget(anchor)
          }, pickRow: (target, mode) => {
            if (mode === 'chat-node') return chat.pick(target)
            const snapshot = session.getSnapshot()
            const chatSnapshot = snapshot.chat
            const group = target.groupKey === undefined ? undefined : chatSnapshot.groups.get(target.groupKey)
            const nodeKey = target.nodeKey ?? group?.members[0]?.key
            const node = nodeKey === undefined ? undefined : chatSnapshot.nodes.get(nodeKey)
            const location = node?.location
            return log.pick({ ...target, ...node === undefined ? {} : { anchorSeq: node.anchorSeq, nodeKind: node.kind },
              ...location?.kind === 'turn' || location?.kind === 'step' ? { turn: location.turn.turn } : {},
              ...location?.kind === 'step' ? { step: location.step.step } : {} })
          } }
        models.set(binding, sources)
      }
      return sources
    },
  }, SessionInspectorView))
}
