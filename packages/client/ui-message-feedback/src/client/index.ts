/**
 * Message feedback plugin, browser half: the Like/Dislike entry in the
 * conversation.chat.assistant-actions strip. One MessageFeedbackController per
 * Session backs every message control in that Session, so a single list read
 * seeds the whole transcript. Mutations go through the generated
 * messageFeedback Remote; the Host owns per-item compare-and-set.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the assistant-actions entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { FeedbackDialog } from './FeedbackDialog.tsx'
import { FeedbackDialogController } from './dialog.ts'
import type { FeedbackDialogInjected } from './slots.ts'
import { MessageFeedbackController } from './controller.ts'
import { MessageFeedbackActions } from './MessageFeedbackActions.tsx'
import type { MessageFeedbackInjected } from './slots.ts'
import { en, zh } from './locales.ts'

export type {
  MessageFeedbackActionResult, MessageFeedbackStatus, MessageFeedbackView, MessageFeedbackRemote,
} from './controller.ts'
export type { MessageFeedbackActionProps, MessageFeedbackInjected } from './slots.ts'
export type { MessageFeedbackKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'feedback'

/** Required services: the slot registry, the Remote namespace, and the copy. */
export const inject = ['slots', 'remote', 'remote.messageFeedback', 'remote.sessionFeedback', 'locale', 'sessions']

/**
 * Client plugin body: the per-message feedback entry and its per-session
 * object layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-message-feedback: dictionaries')

  const controllers = new Map<SessionId, MessageFeedbackController>()
  const controllerFor = (sessionId: SessionId): MessageFeedbackController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      const scope = ctx.sessions.scope(sessionId)
      if (scope === undefined) throw new Error(`Feedback requires a retained Session: ${sessionId}`)
      controller = new MessageFeedbackController(ctx.remote.messageFeedback, sessionId)
      controllers.set(sessionId, controller)
      const owned = controller
      scope.effect(() => () => {
        owned.dispose()
        if (controllers.get(sessionId) === owned) controllers.delete(sessionId)
      }, 'ui-message-feedback: message read lifetime')
    }
    return controller
  }

  const dialogs = new Map<SessionId, FeedbackDialogController>()
  const dialogFor = (sessionId: SessionId): FeedbackDialogController => {
    let dialog = dialogs.get(sessionId)
    if (dialog === undefined) {
      const scope = ctx.sessions.scope(sessionId)
      if (scope === undefined) throw new Error(`Feedback requires a retained Session: ${sessionId}`)
      dialog = new FeedbackDialogController(async (_target, entry) => {
        const result = await ctx.remote.sessionFeedback.record({ sessionId, ...entry })
        if (!result.ok) return { ok: false, error: result.error }
        if (result.value.ok) return { ok: true }
        return { ok: false, error: { code: result.value.error.code, message: result.value.error.code } }
      })
      dialogs.set(sessionId, dialog)
      const owned = dialog
      scope.effect(() => () => {
        owned.dispose()
        if (dialogs.get(sessionId) === owned) dialogs.delete(sessionId)
      }, 'ui-message-feedback: Session lifetime')
    }
    return dialog
  }
  ctx.effect(() => () => {
    for (const dialog of dialogs.values()) dialog.dispose()
    dialogs.clear()
  }, 'ui-message-feedback: session dialogs')
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'feedback-dialog', order: 2, locale: NS,
    inject: (sessionId): FeedbackDialogInjected => {
      const dialog = dialogFor(sessionId)
      return {
        hooks: { dialog: dialog.state }, edit: (draft) => { dialog.edit(draft) },
        submit: () => dialog.submitDraft(), dismiss: () => { dialog.dismiss() },
        dismissFailure: () => { dialog.dismissFailure() }, dismissToast: (seq) => { dialog.dismissToast(seq) },
      }
    },
  }, FeedbackDialog))
  ctx.inject(['commandUi'], (scope) => {
    scope.effect(() => scope.commandUi.decorate({
      name: 'feedback', available: () => true,
      ui: { kind: 'action', run: (session) => { dialogFor(session.sessionId).open({ kind: 'session' }) } },
    }), 'ui-message-feedback: session command')
  })

  // A reconnect can only invalidate what was already read; a cold Session
  // stays cold until something asks for it.
  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) {
      if (controller.getSnapshot().status !== 'cold') void controller.resync()
    }
  })

  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'feedback',
      order: 10,
      locale: NS,
      inject: (sessionId): MessageFeedbackInjected => {
        const controller = controllerFor(sessionId)
        return {
          hooks: { feedback: controller },
          ensure: () => controller.ensure(),
          rate: (messageId, rating, note) => controller.rate(messageId, rating, note),
          toggle: (messageId, rating) => controller.toggle(messageId, rating),
          clearNote: messageId => controller.clearNote(messageId),
          clear: messageId => controller.clear(messageId),
        }
      },
    }, MessageFeedbackActions)
    return () => {
      dispose()
      for (const controller of controllers.values()) controller.dispose()
      controllers.clear()
    }
  })
}
