/**
 * Plan-mode control, persistent Chat cards, and Session-backed Sidebar
 * previews: the composer's `conversation.input.plan` seat keeps the
 * active-state chip, completed Turns carry one card per `exit_plan_mode`
 * invocation, a pending plan review opens its document automatically, and
 * the `plan` Sidebar type renders logged or temporary Markdown read-only.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan and turnTail seats).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `plan` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { PlanCards, PlanReviewOpen, type PlanCardsInjected, type PlanOpenInjected, type PlanReviewOpenInjected } from './PlanCard.tsx'
import { PlanPreview, PlanTitle, type PlanPreviewInjected } from './PlanPreview.tsx'
import { plansSourceFor, submittedPlanDefinition } from './plan-definition.ts'
import { PlanReadStore } from './plan-resource.ts'
import { planAddress, parsePlanAddress, type PlanSessionAddress, type SubmittedPlan } from './plan.ts'
import { isReviewPreviewAddress, parseReviewPreviewAddress, reviewPreviewAddress } from './review-preview.ts'
import { createPlanReviewStore } from './review-store.ts'
import { PlanChip } from './PlanModeControl.tsx'
import { en, zh, type PlanKey } from './locales.ts'

export type { PlanKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The plan chip's, transcript cards', and preview copy. */
    plan: PlanKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'plan'

/** Injected business face of the composer plan seat. */
export interface PlanChipInjected {
  /**
   * Leave plan mode by executing /plan off.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  exitPlanMode: () => Promise<string | null>
}

/** The tab kind this package owns. */
const PLAN_TAB_ID = '@deepseek-ai/dsh-client-ui-plan'

/** Services for plan controls, Conversation projection, and resource navigation. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale', 'conversationEvents', 'sessions', 'sidebarRight', 'sidebarRightTabs']

/**
 * Register plan controls, permanent Chat cards, and Sidebar document reading.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plan: dictionaries')

  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.conversationEvents.register(submittedPlanDefinition), 'ui-plan: plan definition')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PLAN_TAB_ID, kind: 'plan',
    patterns: ['dsh-resource://plan/**', 'dsh-resource://plan-review/**'], priority: 'builtin',
    resourceSession: (address) => {
      const plan = parsePlanAddress(address)
      if (plan !== undefined) return plan.session.kind === 'session' ? plan.session.sessionId : plan.session.childSessionId
      return parseReviewPreviewAddress(address)?.sessionId
    },
    canOpen: address => parsePlanAddress(address) !== undefined || isReviewPreviewAddress(address),
    title: () => t('preview.title'),
  }), 'ui-plan: sidebar type')
  const reads = new PlanReadStore(ctx.sessions)
  ctx.effect(() => () => { void reads.dispose() }, 'ui-plan: plan reads')
  ctx.on('connection/reset', () => { reads.reset() })
  const open = (sessionId: SessionId): PlanOpenInjected => ({
    openPlan: (callId) => {
      const child = ctx.sessions.subagentAddress(sessionId)
      const session: PlanSessionAddress = child === undefined
        ? { kind: 'session', sessionId }
        : { kind: 'subagent', ...child }
      ctx.sidebarRight.openSessionResource(sessionId, planAddress({ session, callId }))
    },
  })
  const reviewWindow = randomUUID()
  const reviewStore = createPlanReviewStore()
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: PLAN_TAB_ID, locale: NS,
    inject: (sessionId: SessionId): PlanCardsInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`ui-plan: unknown session "${sessionId}"`)
      const sources = new Map<number, ObservableSnapshot<readonly SubmittedPlan[]>>()
      return {
        ...open(sessionId),
        keyedHooks: {
          plans: (turn) => {
            const key = Number(turn)
            let source = sources.get(key)
            if (source === undefined) {
              source = plansSourceFor(binding.session, key)
              sources.set(key, source)
            }
            return source
          },
        },
      }
    },
  }, PlanCards))
  ctx.slots.inject('conversation.plan-review.actions', () => ctx.slots.register({
    name: 'conversation.plan-review.actions', id: PLAN_TAB_ID, locale: NS, store: reviewStore,
    inject: (sessionId: SessionId): PlanReviewOpenInjected => ({
      openReview: (review, requestKey) => {
        // Read at call time, not from a render: between a departing seat's
        // release and the arriving seat's bind no seat can take the open.
        if (ctx.sidebarRight.mounted.getSnapshot() === undefined) return false
        if (review.callId !== undefined) { open(sessionId).openPlan(review.callId); return true }
        ctx.sidebarRight.openSessionResource(sessionId, reviewPreviewAddress(sessionId, `${reviewWindow}:${requestKey}`), {
          params: { planReview: { markdown: review.plan, title: extractMarkdownPlainText(review.plan, { mode: 'first-line' }) } },
        })
        return true
      },
      hooks: { sidebarMounted: ctx.sidebarRight.mounted },
    }),
  }, PlanReviewOpen))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: PLAN_TAB_ID, locale: NS,
    inject: (): PlanPreviewInjected => ({
      hooks: { planDocument: reads.state },
      loadPlan: address => reads.load(address),
    }),
  }, PlanPreview))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: PLAN_TAB_ID, locale: NS,
    inject: (): PlanPreviewInjected => ({
      hooks: { planDocument: reads.state },
      loadPlan: address => reads.load(address),
    }),
  }, PlanTitle))

  ctx.slots.inject('conversation.input.plan', () => ctx.slots.register({
    name: 'conversation.input.plan',
    locale: NS,
    inject: (sessionId: SessionId): PlanChipInjected => ({
      // Failure strings stay English (error-surface policy: not localized).
      exitPlanMode: async () => {
        const result = await ctx.remote.commands.execute(sessionId, '/plan off', [])
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /plan off'
        return null
      },
    }),
  }, PlanChip))
}
