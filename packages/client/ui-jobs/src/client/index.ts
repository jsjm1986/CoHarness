/**
 * Background-job plugin, browser half: contributes one session-header action
 * that renders this session's `ctx.jobs` records. The roster arrives through
 * the `jobsBySession` list mirror, and per-row live output plus the human
 * kill ride the sessions service's `observeJob`/`killJob`; this plugin holds
 * no transport state of its own.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { JobListAction } from './JobListAction.tsx'
import type { JobListInjected } from './JobListAction.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps, JobListInjected } from './JobListAction.tsx'

/** Required services for job control, locale registration, and the header slot. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-job: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      // After the subagent catalog: session lineage reads before process work.
      order: 20,
      locale: NS,
      inject: (): JobListInjected => ({
        observe: (sessionId, id) => ctx.sessions.observeJob(sessionId, id),
        killJob: (sessionId, jobId) => ctx.sessions.killJob(sessionId, jobId),
      }),
    }, JobListAction),
  )
}
